-- 0025: Virtual vs in-person site visits.
-- Same event_type (site_visit_booked) so combined counts stay one query;
-- visit_kind is the split for reports, the popup, and the calendar.

alter table activities
  add column if not exists visit_kind text;

alter table activities
  drop constraint if exists activities_visit_kind_check;

alter table activities
  add constraint activities_visit_kind_check
  check (visit_kind is null or visit_kind in ('in_person', 'virtual'));

comment on column activities.visit_kind is
  'in_person | virtual. Null on historical site_visit_booked rows (treat as in_person). Ignored for other event types.';

alter table pending_site_visits
  add column if not exists visit_kind text;

alter table pending_site_visits
  drop constraint if exists pending_site_visits_visit_kind_check;

alter table pending_site_visits
  add constraint pending_site_visits_visit_kind_check
  check (visit_kind is null or visit_kind in ('in_person', 'virtual'));

create index if not exists activities_visit_kind_idx
  on activities (company_id, visit_kind, occurred_on desc)
  where event_type = 'site_visit_booked' and visit_kind is not null;
