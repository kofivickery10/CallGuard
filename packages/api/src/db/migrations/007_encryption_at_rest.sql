ALTER TABLE calls ADD COLUMN encrypted_at_rest BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE knowledge_base_files ADD COLUMN encrypted_at_rest BOOLEAN NOT NULL DEFAULT false;
