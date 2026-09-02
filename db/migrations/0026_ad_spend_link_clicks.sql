-- Meta inline_link_clicks (destination / outbound link clicks), distinct from
-- `clicks` which includes likes, "see more", and other non-link taps.
alter table ad_spend
  add column if not exists link_clicks int not null default 0;
