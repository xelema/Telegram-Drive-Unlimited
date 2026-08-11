export interface ShareInfo {
  id: string;
  folder_id: number | null;
  message_id: number;
  file_name: string;
  file_size: number;
  created_at: number;
  expires_at: number | null;
  revoked: boolean;
  has_password: boolean;
  link: string;
}
