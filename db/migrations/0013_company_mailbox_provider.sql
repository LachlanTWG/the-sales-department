-- 0013: Default mailbox provider per client.
-- Source of truth for Gmail clients: Google Cloud OAuth test users (domains).
-- Gmail: HDK, LRS, Hughes, East Coast Electrical, Nexgen, Enervia.
-- Outlook: everyone else (Bolton, Phased, Sunbridge, …).
-- Gmail mailboxes must be added as Google Cloud OAuth test users.
-- UI pre-selects provider; OAuth still allows override.

alter table companies
  add column if not exists mailbox_provider text not null default 'outlook';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'companies_mailbox_provider_check'
  ) then
    alter table companies
      add constraint companies_mailbox_provider_check
      check (mailbox_provider in ('gmail', 'outlook'));
  end if;
end $$;

-- Default all active clients to Outlook, then mark known Gmail domains.
update companies set mailbox_provider = 'outlook' where active = true;

update companies
   set mailbox_provider = 'gmail'
 where slug in (
   'hdk-long-run-roofing',
   'lrs-electrical-solar',
   'hughes-electrical',
   'east-coast-electrical'
 );
