export type ScoreType = 'binary' | 'scale_1_5' | 'scale_1_10';

export interface ScorecardItem {
  id: string;
  scorecard_id: string;
  label: string;
  description: string | null;
  score_type: ScoreType;
  weight: number;
  sort_order: number;
  created_at: string;
}

export interface Scorecard {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  items?: ScorecardItem[];
}

export interface CreateScorecardInput {
  name: string;
  description?: string;
  items: {
    label: string;
    description?: string;
    score_type: ScoreType;
    weight: number;
    sort_order: number;
  }[];
}

export interface UpdateScorecardInput {
  name?: string;
  description?: string;
  is_active?: boolean;
  items?: {
    id?: string;
    label: string;
    description?: string;
    score_type: ScoreType;
    weight: number;
    sort_order: number;
  }[];
}
