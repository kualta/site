-- Retire outstanding app-password requests when upgrading to OAuth.
UPDATE publisher_connections SET state='failed', payload=NULL,
  message='Connect again with OAuth.'
  WHERE platform IN ('grain','bluesky') AND state IN ('queued','working');
UPDATE publisher_connections SET payload=NULL;
UPDATE publisher_helper SET public_key=NULL;
