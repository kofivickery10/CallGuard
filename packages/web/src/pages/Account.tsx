import { useState, FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';

interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: string;
}

export default function Account() {
  const { user: authUser, refreshUser } = useAuth();
  const queryClient = useQueryClient();

  const [nameValue, setNameValue] = useState('');
  const [nameEditing, setNameEditing] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSaved, setPwSaved] = useState(false);

  const { data } = useQuery({
    queryKey: ['user-me'],
    queryFn: () => api.get<{ user: UserProfile }>('/users/me'),
  });

  const user = data?.user;

  const nameMutation = useMutation({
    mutationFn: (name: string) => api.put('/users/me', { name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['user-me'] });
      await refreshUser();
      setNameEditing(false);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 3000);
    },
  });

  const pwMutation = useMutation({
    mutationFn: ({ current, next }: { current: string; next: string }) =>
      api.put('/users/me/password', { current_password: current, new_password: next }),
    onSuccess: () => {
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setPwError('');
      setPwSaved(true);
      setTimeout(() => setPwSaved(false), 3000);
    },
    onError: (err: Error) => setPwError(err.message),
  });

  const handleNameSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (nameValue.trim()) nameMutation.mutate(nameValue.trim());
  };

  const handlePwSubmit = (e: FormEvent) => {
    e.preventDefault();
    setPwError('');
    if (newPw !== confirmPw) {
      setPwError('New passwords do not match');
      return;
    }
    if (newPw.length < 8) {
      setPwError('Password must be at least 8 characters');
      return;
    }
    pwMutation.mutate({ current: currentPw, next: newPw });
  };

  const startEditName = () => {
    setNameValue(user?.name ?? '');
    setNameEditing(true);
  };

  const roleLabel: Record<string, string> = {
    admin: 'Admin',
    supervisor: 'Supervisor',
    viewer: 'Viewer',
    adviser: 'Adviser',
    superadmin: 'Superadmin',
  };

  return (
    <div className="p-6 max-w-xl space-y-6">
      <h1 className="text-page-title">My Account</h1>

      {/* Profile */}
      <div className="bg-card rounded-card border border-border p-5 space-y-4">
        <h2 className="text-[15px] font-semibold text-text-primary">Profile</h2>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-table-cell text-text-muted w-24">Name</span>
            {nameEditing ? (
              <form onSubmit={handleNameSubmit} className="flex items-center gap-2 flex-1 ml-3">
                <input
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  className="flex-1 border border-border rounded-btn px-3 py-1.5 text-table-cell"
                  autoFocus
                />
                <button type="submit" disabled={nameMutation.isPending} className="text-sm font-medium text-primary hover:text-primary-hover disabled:opacity-60">Save</button>
                <button type="button" onClick={() => setNameEditing(false)} className="text-sm text-text-muted">Cancel</button>
              </form>
            ) : (
              <div className="flex items-center gap-2 flex-1 ml-3">
                <span className="text-table-cell text-text-primary flex-1">{user?.name}</span>
                <button onClick={startEditName} className="text-xs text-primary hover:underline">Edit</button>
              </div>
            )}
          </div>
          {nameSaved && <p className="text-xs text-pass">Name updated.</p>}
          <div className="flex items-center">
            <span className="text-table-cell text-text-muted w-24">Email</span>
            <span className="text-table-cell text-text-secondary ml-3">{user?.email ?? authUser?.email}</span>
          </div>
          <div className="flex items-center">
            <span className="text-table-cell text-text-muted w-24">Role</span>
            <span className="text-table-cell text-text-secondary ml-3">{roleLabel[user?.role ?? ''] ?? user?.role}</span>
          </div>
        </div>
      </div>

      {/* Change password */}
      <div className="bg-card rounded-card border border-border p-5 space-y-4">
        <h2 className="text-[15px] font-semibold text-text-primary">Change Password</h2>
        <form onSubmit={handlePwSubmit} className="space-y-3">
          {[
            { label: 'Current password', value: currentPw, set: setCurrentPw },
            { label: 'New password',     value: newPw,     set: setNewPw },
            { label: 'Confirm new',      value: confirmPw, set: setConfirmPw },
          ].map(({ label, value, set }) => (
            <div key={label}>
              <label className="block text-table-cell text-text-muted mb-1">{label}</label>
              <input
                type="password"
                value={value}
                onChange={(e) => set(e.target.value)}
                required
                className="w-full border border-border rounded-btn px-3 py-2 text-table-cell focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          ))}
          {pwError  && <p className="text-sm text-fail">{pwError}</p>}
          {pwSaved  && <p className="text-sm text-pass">Password changed successfully.</p>}
          <button
            type="submit"
            disabled={pwMutation.isPending}
            className="bg-primary hover:bg-primary-hover text-white font-semibold px-4 py-2 rounded-btn text-table-cell disabled:opacity-60 transition-colors"
          >
            {pwMutation.isPending ? 'Saving…' : 'Update password'}
          </button>
        </form>
      </div>

      {/* Two-factor authentication */}
      <TwoFactorSection />
    </div>
  );
}

// Manage the (mandatory) second factor: shows status and lets the user regenerate
// backup codes, which requires a live authenticator code to authorise.
function TwoFactorSection() {
  const [code, setCode] = useState('');
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  const { data, refetch } = useQuery({
    queryKey: ['2fa-status'],
    queryFn: () => api.get<{ enabled: boolean; backup_codes_remaining: number }>('/auth/2fa/status'),
  });

  const regen = useMutation({
    mutationFn: (totp: string) =>
      api.post<{ backup_codes: string[] }>('/auth/2fa/backup-codes/regenerate', { code: totp }),
    onSuccess: (res) => {
      setNewCodes(res.backup_codes);
      setCode('');
      setError('');
      refetch();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="bg-card rounded-card border border-border p-5 space-y-4">
      <h2 className="text-[15px] font-semibold text-text-primary">Two-Factor Authentication</h2>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${data?.enabled ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'}`}>
          {data?.enabled ? 'Enabled' : 'Not enabled'}
        </span>
        {data?.enabled && (
          <span className="text-table-cell text-text-muted">
            {data.backup_codes_remaining} backup code{data.backup_codes_remaining === 1 ? '' : 's'} remaining
          </span>
        )}
      </div>

      {data?.enabled && (
        <>
          <p className="text-table-cell text-text-muted">
            Regenerate your backup codes if you've used most of them or think they may be exposed.
            This invalidates your existing codes. Enter a code from your authenticator to confirm.
          </p>
          {newCodes ? (
            <div className="space-y-2">
              <p className="text-table-cell text-text-secondary">Your new backup codes — save them now, they won't be shown again:</p>
              <div className="grid grid-cols-2 gap-2 bg-page rounded-card p-4">
                {newCodes.map((c) => (
                  <code key={c} className="text-[13px] text-text-primary text-center py-1">{c}</code>
                ))}
              </div>
            </div>
          ) : (
            <form
              onSubmit={(e) => { e.preventDefault(); if (code.trim()) regen.mutate(code.trim()); }}
              className="flex items-end gap-2"
            >
              <div className="flex-1 max-w-[180px]">
                <label className="block text-table-cell text-text-muted mb-1">Authenticator code</label>
                <input
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                  className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-center tracking-[4px] focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
              <button
                type="submit"
                disabled={regen.isPending}
                className="bg-primary hover:bg-primary-hover text-white font-semibold px-4 py-2 rounded-btn text-table-cell disabled:opacity-60 transition-colors"
              >
                {regen.isPending ? 'Working…' : 'Regenerate codes'}
              </button>
            </form>
          )}
          {error && <p className="text-sm text-fail">{error}</p>}
        </>
      )}
    </div>
  );
}
