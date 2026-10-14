export type MaintenanceAction =
  | 'backup'
  | 'verify_backup'
  | 'restore_backup'
  | 'delete_folder'
  | 'reconcile_images';

export type BackupWorkflowParams = {
  action?: MaintenanceAction;
  backupId?: string;
  jobId?: string;
  folderId?: number;
  label?: string;
  retention?: number;
  scheduled?: boolean;
};
