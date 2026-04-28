import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

interface ScoreCorrectionModalProps {
  callId: string;
  itemScoreId: string;
  itemLabel: string;
  currentPass: boolean;
  evidence: string | null;
  onClose: () => void;
}

export function ScoreCorrectionModal({
  callId,
  itemScoreId,
  itemLabel,
  currentPass,
  evidence,
  onClose,
}: ScoreCorrectionModalProps) {
  const queryClient = useQueryClient();
  const [correctedPass, setCorrectedPass] = useState<boolean>(!currentPass);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post(`/calls/${callId}/scores/items/${itemScoreId}/correct`, {
        corrected_pass: correctedPass,
        reason: reason || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['call-scores', callId] });
      queryClient.invalidateQueries({ queryKey: ['call', callId] });
      queryClient.invalidateQueries({ queryKey: ['breaches'] });
      queryClient.invalidateQueries({ queryKey: ['breach-summary'] });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-text-primary/30" onClick={onClose} />
      <div className="relative bg-white border border-border rounded-card w-full max-w-lg p-6 shadow-lg">
        <h3 className="text-[15px] font-semibold text-text-primary mb-1">Correct Score</h3>
        <p className="text-table-cell text-text-subtle mb-4">
          Your correction is saved and becomes a calibration example in future scoring prompts.
          The AI learns your firm's interpretation over time.
        </p>

        <div className="bg-table-header rounded-btn p-3 mb-4">
          <div className="text-[12px] text-text-muted font-semibold mb-1">Criterion</div>
          <div className="text-table-cell text-text-primary">{itemLabel}</div>
          {evidence && (
            <>
              <div className="text-[12px] text-text-muted font-semibold mt-2 mb-1">AI evidence</div>
              <div className="text-[12px] text-text-cell italic">"{evidence}"</div>
            </>
          )}
        </div>

        {error && (
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{error}</div>
        )}

        <form onSubmit={handleSave}>
          <div className="mb-4">
            <label className="block text-[12px] text-text-muted font-semibold mb-2">Correct verdict</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCorrectedPass(true)}
                className={`flex-1 py-2 rounded-btn text-table-cell font-semibold border transition-colors ${
                  correctedPass
                    ? 'bg-pass-bg text-pass border-pass'
                    : 'border-border text-text-cell hover:bg-sidebar-hover'
                }`}
              >
                Pass
              </button>
              <button
                type="button"
                onClick={() => setCorrectedPass(false)}
                className={`flex-1 py-2 rounded-btn text-table-cell font-semibold border transition-colors ${
                  !correctedPass
                    ? 'bg-fail-bg text-fail border-fail'
                    : 'border-border text-text-cell hover:bg-sidebar-hover'
                }`}
              >
                Fail
              </button>
            </div>
            <div className="text-[11px] text-text-muted mt-2">
              AI said: <strong>{currentPass ? 'Pass' : 'Fail'}</strong>
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-[12px] text-text-muted font-semibold mb-1">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Agent partially covered this with the 'any questions' prompt — we count that as pass"
              className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save Correction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
