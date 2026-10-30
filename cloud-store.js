'use strict';

function createSupabaseClient({ url, anonKey, serviceKey, fetchImpl = fetch }) {
  const base = String(url || '').replace(/\/$/, '');
  const request = async (pathname, options = {}, token) => {
    if (!base || !anonKey) throw new Error('云端服务尚未配置。');
    const headers = { apikey: anonKey, ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${base}${pathname}`, { ...options, headers });
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const error = new Error('云端服务暂时不可用。');
      error.status = response.status;
      error.safeBody = data;
      throw error;
    }
    return data;
  };
  const authUser = async token => request('/auth/v1/user', {}, token);
  const dbRequest = async (path, options = {}) => {
    if (!serviceKey) throw new Error('云端服务尚未配置。');
    return request(`/rest/v1${path}`, { ...options, headers: { ...(options.headers || {}), apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  };
  const assetRequest = async (bucket, path, options = {}) => {
    if (!serviceKey) throw new Error('云端服务尚未配置。');
    return fetchImpl(`${base}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      ...options,
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, ...(options.headers || {}) },
    });
  };
  return { base, authUser, dbRequest, assetRequest };
}

function createCloudStore({ url, anonKey, serviceKey, bucket = 'vibecanvas-private', fetchImpl = fetch } = {}) {
  const client = createSupabaseClient({ url, anonKey, serviceKey, fetchImpl });
  const configured = Boolean(url && anonKey && serviceKey);
  const ensure = () => { if (!configured) throw new Error('云端服务尚未配置，请填写 SUPABASE_URL、SUPABASE_ANON_KEY 和 SUPABASE_SERVICE_ROLE_KEY。'); };
  const list = userId => { ensure(); return client.dbRequest(`/cloud_works?user_id=eq.${encodeURIComponent(userId)}&select=*&order=updated_at.desc`); };
  const get = (userId, id) => { ensure(); return client.dbRequest(`/cloud_works?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=*`); };
  const findByLocalId = (userId, sourceLocalId) => { ensure(); return client.dbRequest(`/cloud_works?user_id=eq.${encodeURIComponent(userId)}&source_local_id=eq.${encodeURIComponent(sourceLocalId)}&select=*`); };
  const insert = (record) => { ensure(); return client.dbRequest('/cloud_works', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(record) }); };
  const update = (userId, id, expectedRevision, patch) => { ensure(); return client.dbRequest(`/cloud_works?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&revision=eq.${Number(expectedRevision)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(patch) }); };
  const remove = (userId, id) => { ensure(); return client.dbRequest(`/cloud_works?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); };
  const uploadAsset = async ({ userId, workId, assetId, mime, data }) => { ensure(); const path = `${userId}/${workId}/${assetId}`; const response = await client.assetRequest(bucket, path, { method: 'POST', headers: { 'Content-Type': mime, 'x-upsert': 'true', 'Cache-Control': 'private, max-age=0' }, body: data }); if (!response.ok) throw new Error('图片上传失败。'); return { path, mime, size: data.length }; };
  const removeAsset = async path => { ensure(); const response = await client.assetRequest(bucket, path, { method: 'DELETE' }); if (!response.ok && response.status !== 404) throw new Error('云端图片删除失败。'); };
  const signedAssetUrl = async path => { ensure(); const response = await fetchImpl(`${client.base}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) }); if (!response.ok) throw new Error('云端图片访问失败。'); const data = await response.json(); const signed=data.signedURL || data.signedUrl || null; return signed && signed.startsWith('/') ? `${client.base}${signed}` : signed; };
  return { configured, client, list, get, findByLocalId, insert, update, remove, uploadAsset, removeAsset, signedAssetUrl, bucket };
}

module.exports = { createSupabaseClient, createCloudStore };
