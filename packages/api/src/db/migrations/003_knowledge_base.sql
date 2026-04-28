CREATE TABLE knowledge_base_sections (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    section_type    TEXT NOT NULL CHECK (section_type IN
                      ('company_overview','products','compliance','scripts','objections','glossary')),
    content         TEXT NOT NULL DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, section_type)
);

CREATE TABLE knowledge_base_files (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    section_id      UUID NOT NULL REFERENCES knowledge_base_sections(id) ON DELETE CASCADE,
    file_name       TEXT NOT NULL,
    file_key        TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    file_size_bytes BIGINT,
    extracted_text  TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kb_sections_org ON knowledge_base_sections(organization_id);
CREATE INDEX idx_kb_files_section ON knowledge_base_files(section_id);
