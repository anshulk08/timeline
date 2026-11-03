// Access control for Jotter. PROTECTED: the Complaint->Commit diff gate refuses any change here.
export const ROLES = {
  admin: ['read', 'write', 'delete', 'manage_users'],
  member: ['read', 'write'],
  guest: ['read'],
};
const USERS = { anshul: 'admin', judge: 'member' };
export function roleOf(user) { return USERS[user] || 'guest'; }
export function can(user, perm) { return (ROLES[roleOf(user)] || []).includes(perm); }
export function whoami(user) { return { user: user || 'anonymous', role: roleOf(user), perms: ROLES[roleOf(user)] }; }
