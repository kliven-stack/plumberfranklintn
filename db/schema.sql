-- Run once, in the Neon SQL editor, after connecting the database to the Vercel
-- project (playbook §5.1). The Neon integration injects DATABASE_URL itself.

create table if not exists submissions (
  id            bigserial primary key,
  created_at    timestamptz  not null default now(),

  -- The Book Appointment form, field for field as Gravity Forms rendered it.
  name          text,
  email         text         not null,
  phone         text         not null,
  customer_type text         not null,
  emergency     text         not null,
  message       text,

  -- Where the submission came from, for triage.
  page_path     text,
  user_agent    text,
  -- SHA-256 of (IP + IP_HASH_SALT). The raw address is never stored: this exists
  -- only to spot repeat submissions, and is useless without the salt.
  ip_hash       text
);

create index if not exists submissions_created_at_idx on submissions (created_at desc);
create index if not exists submissions_email_idx on submissions (email);
