import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import CreateTenantModal from './CreateTenantModal';

interface Tenant {
  id: string;
  name: string;
  plan: string;
  status: string;
  created_at: string;
  user_count: string;
  active_seats_mtd: string;
}

const planColour: Record<string, string> = {
  core:         'bg-processing-bg text-processing',
  professional: 'bg-pass-bg text-pass',
  enterprise:   'bg-review-bg text-review',
};

const statusColour: Record<string, string> = {
  active:    'bg-pass-bg text-pass',
  suspended: 'bg-review-bg text-review',
  cancelled: 'bg-fail-bg text-fail',
};

export default function TenantList() {
  const [tenants, setTenants]     = useState<Tenant[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [error, setError]         = useState('');

  const load = () => {
    api.get<{ tenants: Tenant[] }>('/superadmin/tenants')
      .then((r) => setTenants(r.tenants))
      .catch((e: Error) => setError(e.message));
  };

  useEffect(load, []);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-page-title text-text-primary">Tenants</h2>
        <button
          onClick={() => setShowModal(true)}
          className="bg-primary hover:bg-primary-hover text-white text-sm font-semibold px-4 py-2 rounded-btn transition-colors"
        >
          + New tenant
        </button>
      </div>

      {error && <p className="text-fail text-sm">{error}</p>}

      <div className="bg-card rounded-card border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-table-header border-b border-border">
            <tr>
              {['Organisation', 'Plan', 'Status', 'Users', 'Active seats (MTD)', 'Created', ''].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tenants.map((t) => (
              <tr key={t.id} className="hover:bg-sidebar-hover">
                <td className="px-4 py-3 font-medium text-text-primary">{t.name}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold capitalize ${planColour[t.plan] ?? ''}`}>
                    {t.plan}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold capitalize ${statusColour[t.status] ?? ''}`}>
                    {t.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-text-secondary">{t.user_count}</td>
                <td className="px-4 py-3 text-text-secondary">{t.active_seats_mtd}</td>
                <td className="px-4 py-3 text-text-muted">
                  {new Date(t.created_at).toLocaleDateString('en-GB')}
                </td>
                <td className="px-4 py-3">
                  <Link to={`/tenants/${t.id}`} className="text-primary hover:underline text-xs font-medium">
                    View
                  </Link>
                </td>
              </tr>
            ))}
            {tenants.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-text-muted">
                  No tenants yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <CreateTenantModal
          onClose={() => setShowModal(false)}
          // Refresh the list in the background, but leave the modal open so
          // its credentials screen (org id, admin user id, temp password) can
          // render — that screen is the only place the temp password is ever
          // shown, and it never gets a chance to if the modal closes here too.
          onCreated={load}
        />
      )}
    </div>
  );
}
