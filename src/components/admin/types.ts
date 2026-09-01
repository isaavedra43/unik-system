export interface UserView {
  id: string;
  name: string;
  username: string;
  email: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: { id: string; key: string; name: string }[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleOption {
  id: string;
  key: string;
  name: string;
}

export interface UserPermissions {
  canCreate: boolean;
  canUpdate: boolean;
  canChangeStatus: boolean;
  canAssignRoles: boolean;
  canResetPassword: boolean;
}

export interface RolePermissions {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canManagePermissions: boolean;
}
