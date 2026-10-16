// Shared Domain Models & Contracts for AuraStudio Platform
// Used across Cloudflare Worker API, D1 Database, and Web Frontend

export type GenerationStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';

export interface UserProfile {
  id: string;
  name?: string;
  email?: string;
  username?: string;
  avatar_url?: string;
  is_admin?: boolean;
  role?: string;
  stars_balance?: number;
  free_generations_used?: number;
  total_generations?: number;
  created_at?: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  plan_tier: 'starter' | 'unlimited';
  status: 'active' | 'expired' | 'canceled';
  expires_at: string;
  created_at: string;
}

export interface GenerationRecord {
  id: string;
  user_id: string;
  source: 'web' | 'telegram_bot' | 'api';
  preset_id: string;
  prompt: string;
  input_image_url: string; // Database constraint: NOT NULL
  output_image_url?: string | null;
  status: GenerationStatus;
  duration_seconds: number;
  is_shared: number;
  share_token?: string | null;
  created_at?: string;
  error_message?: string | null;
}

export interface GenerateRequestBody {
  task_id: string;
  image_base64: string | null;
  prompt: string;
  preset_id?: string;
  user_id: string;
  user_email?: string | null;
  user_name?: string | null;
}

export interface GenerateResponseBody {
  status: 'queued' | 'processing' | 'success' | 'auth_required' | 'daily_limit_reached' | 'error';
  task_id?: string;
  mode?: 'text_to_image' | 'image_to_image';
  share_token?: string;
  share_url?: string;
  twitter_intent_url?: string;
  daily_limit?: number;
  free_remaining?: number;
  message?: string;
}

export interface QueueStatusResponse {
  status: 'success' | 'error';
  active_jobs: number;
  queue_position: number;
  is_warm: boolean;
  seconds_since_last: number | null;
  estimated_seconds: number;
  cluster: string;
}

export interface TaskStatusResponse {
  status: 'success' | 'processing' | 'failed' | 'not_found' | 'error';
  task_id?: string;
  share_token?: string | null;
  share_url?: string;
  output_image_url?: string | null;
  duration_seconds?: number;
  error?: string;
  message?: string;
}

export interface ActiveClientTask {
  taskId: string;
  prompt: string;
  presetId: string;
  hasPhoto: boolean;
  inputImage: string | null;
  startedAt: number;
  etaSec: number;
  isWarm?: boolean;
}
