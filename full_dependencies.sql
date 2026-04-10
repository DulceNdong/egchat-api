-- EGCHAT full dependencies (backend sync)
-- Ejecutar completo en Supabase SQL Editor.

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  phone varchar(20) unique not null,
  full_name varchar(100) not null,
  password_hash varchar(255) not null,
  avatar_url text,
  status varchar(20) default 'offline',
  last_seen timestamptz,
  created_at timestamptz default now(),
  last_login timestamptz,
  is_active boolean default true
);

create table if not exists wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references users(id) on delete cascade,
  balance numeric(15,2) default 5000,
  currency varchar(3) default 'XAF',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  type varchar(30) not null,
  amount numeric(15,2) not null,
  method varchar(100),
  reference text,
  status varchar(20) default 'completed',
  created_at timestamptz default now()
);

create table if not exists recharge_codes (
  id uuid primary key default gen_random_uuid(),
  code varchar(40) unique not null,
  amount numeric(15,2) not null,
  used boolean default false,
  used_by uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  contact_user_id uuid references users(id) on delete cascade,
  contact_id uuid references users(id) on delete cascade,
  nickname varchar(100),
  name varchar(100),
  phone varchar(20),
  is_blocked boolean default false,
  is_favorite boolean default false,
  created_at timestamptz default now(),
  unique(user_id, contact_user_id)
);

create table if not exists chats (
  id uuid primary key default gen_random_uuid(),
  type text default 'private',
  name text,
  avatar_url text,
  created_by uuid references users(id) on delete set null,
  participants jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists chat_participants (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references chats(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  joined_at timestamptz default now(),
  unread_count integer default 0,
  unique(chat_id, user_id)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references chats(id) on delete cascade,
  sender_id uuid references users(id) on delete set null,
  text text,
  type text default 'text',
  status text default 'sent',
  reply_to uuid,
  file_url text,
  created_at timestamptz default now()
);

alter table messages
  add constraint if not exists messages_reply_to_fkey
  foreign key (reply_to) references messages(id) on delete set null;

create table if not exists message_reads (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references chats(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  last_read_message_id uuid references messages(id) on delete set null,
  read_at timestamptz default now(),
  unique(chat_id, user_id)
);

create table if not exists lia_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  message text not null,
  reply text not null,
  created_at timestamptz default now()
);

create index if not exists idx_contacts_user on contacts(user_id);
create index if not exists idx_contacts_contact on contacts(contact_user_id);
create index if not exists idx_wallets_user on wallets(user_id);
create index if not exists idx_transactions_user on transactions(user_id);
create index if not exists idx_chats_updated_at on chats(updated_at desc);
create index if not exists idx_chat_participants_user on chat_participants(user_id);
create index if not exists idx_messages_chat on messages(chat_id);
create index if not exists idx_messages_created on messages(created_at desc);
create index if not exists idx_reads_chat_user on message_reads(chat_id, user_id);

insert into recharge_codes (code, amount, expires_at)
values
  ('EGCHAT-RESET-001', 5000, now() + interval '365 days'),
  ('EGCHAT-RESET-002', 10000, now() + interval '365 days')
on conflict (code) do nothing;
