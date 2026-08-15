DROP TRIGGER IF EXISTS agent_messages_roll_up ON agent_messages;
DROP FUNCTION IF EXISTS sw_agent_run_usage();

DROP TRIGGER IF EXISTS agent_messages_same_org ON agent_messages;
DROP FUNCTION IF EXISTS sw_agent_message_same_org();

DROP INDEX IF EXISTS agent_messages_model_idx;

ALTER TABLE agent_messages
  DROP CONSTRAINT IF EXISTS agent_messages_counts_sane,
  DROP CONSTRAINT IF EXISTS agent_messages_content_present,
  DROP CONSTRAINT IF EXISTS agent_messages_role_known;
