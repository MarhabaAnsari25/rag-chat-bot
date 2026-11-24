-- Run this in the Supabase SQL Editor.
-- It is safe to run again. If you already ran an older copy, run this whole script
-- so search can filter by filename, files can be listed, and a file can be deleted.
-- Existing rows get the current time as their upload date, because the old table
-- did not store one. New uploads keep the real upload time.

-- 1. Turn on vector search (pgvector).
create extension if not exists vector with schema extensions;

-- 2. Table that stores each piece of an uploaded file.
create table if not exists public.documents (
  id bigint primary key generated always as identity,
  content text not null,
  metadata jsonb,
  embedding extensions.vector(768),
  created_at timestamptz not null default now()
);

alter table public.documents
  add column if not exists created_at timestamptz not null default now();

-- 3. Search function the app calls.
-- 768 matches Gemini gemini-embedding-001 with outputDimensionality 768.
-- filter_filename is optional. Leave it empty to search every file.
do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'match_documents'
  loop
    execute format('drop function if exists %s', fn);
  end loop;
end $$;

create function public.match_documents (
  query_embedding extensions.vector(768),
  match_threshold float,
  match_count int,
  filter_filename text default null
)
returns table (
  id bigint,
  content text,
  metadata jsonb,
  similarity float
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    documents.id,
    documents.content,
    documents.metadata,
    (1 - (documents.embedding <=> query_embedding))::float as similarity
  from public.documents
  where documents.embedding <=> query_embedding < 1 - match_threshold
    and (
      coalesce(filter_filename, '') = ''
      or documents.metadata->>'filename' = filter_filename
    )
  order by documents.embedding <=> query_embedding asc
  limit least(match_count, 20);
$$;

-- One row per uploaded file, for the document list and the chat filter.
create or replace function public.list_documents()
returns table (
  filename text,
  chunk_count bigint,
  uploaded_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    documents.metadata->>'filename' as filename,
    count(*)::bigint as chunk_count,
    min(documents.created_at) as uploaded_at
  from public.documents
  where coalesce(documents.metadata->>'filename', '') <> ''
  group by documents.metadata->>'filename'
  order by min(documents.created_at) desc, documents.metadata->>'filename' asc;
$$;

-- Speeds up search once you have a lot of file pieces.
create index if not exists documents_embedding_idx
on public.documents
using hnsw (embedding extensions.vector_cosine_ops);

-- Speeds up "this filename only" search and delete.
create index if not exists documents_filename_idx
on public.documents ((metadata->>'filename'));

-- Let the app (using your publishable key) save, read, and delete documents.
alter table public.documents enable row level security;

drop policy if exists "App can insert documents" on public.documents;
create policy "App can insert documents"
on public.documents
for insert
to anon, authenticated
with check (true);

drop policy if exists "App can read documents" on public.documents;
create policy "App can read documents"
on public.documents
for select
to anon, authenticated
using (true);

drop policy if exists "App can delete documents" on public.documents;
create policy "App can delete documents"
on public.documents
for delete
to anon, authenticated
using (true);

grant select, insert, delete on table public.documents to anon, authenticated, service_role;
grant usage, select on sequence public.documents_id_seq to anon, authenticated, service_role;

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('match_documents', 'list_documents')
  loop
    execute format(
      'grant execute on function %s to anon, authenticated, service_role',
      fn
    );
  end loop;
end $$;

notify pgrst, 'reload schema';
