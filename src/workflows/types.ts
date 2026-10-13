export type MaintenanceAction =
  | 'backup'
  | 'verify_backup'
  | 'restore_backup'
  | 'delete_folder'
  | 'reconcile_images'
  | 'mindmap_refinement';

export type BackupWorkflowParams = {
  action?: MaintenanceAction;
  backupId?: string;
  jobId?: string;
  folderId?: number;
  systemId?: number;
  instructions?: string;
  label?: string;
  retention?: number;
  scheduled?: boolean;
};
