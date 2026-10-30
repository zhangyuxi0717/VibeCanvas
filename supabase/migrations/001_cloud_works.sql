create extension if not exists pgcrypto;

create table if not exists public.cloud_works (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_local_id text not null,
  name text not null default '未命名作品',
  document_type text not null default 'single',
  document_json jsonb not null,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, source_local_id)
);

create index if not exists cloud_works_user_updated_idx on public.cloud_works(user_id, updated_at desc);
alter table public.cloud_works enable row level security;
drop policy if exists cloud_works_owner_select on public.cloud_works;
drop policy if exists cloud_works_owner_insert on public.cloud_works;
drop policy if exists cloud_works_owner_update on public.cloud_works;
drop policy if exists cloud_works_owner_delete on public.cloud_works;
create policy cloud_works_owner_select on public.cloud_works for select using (auth.uid() = user_id);
create policy cloud_works_owner_insert on public.cloud_works for insert with check (auth.uid() = user_id);
create policy cloud_works_owner_update on public.cloud_works for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy cloud_works_owner_delete on public.cloud_works for delete using (auth.uid() = user_id);

-- 在 Supabase Dashboard 创建同名私有 bucket：vibecanvas-private。
-- Storage 对象路径由服务端限制为 {user_id}/{work_id}/{asset_id}，不开放公开读取。
