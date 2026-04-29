import { useState } from 'react';
import { Link } from 'react-router-dom';

export function Welcome() {
  return (
    <div className="min-h-screen bg-page">
      {/* Top nav */}
      <header className="bg-white border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-primary rounded-full flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="none">
                <rect x="4.5"  y="14"   width="2.4" height="4"  rx="1.1" fill="white"/>
                <rect x="9"    y="11"   width="2.4" height="7"  rx="1.1" fill="white"/>
                <rect x="13.5" y="8"    width="2.4" height="10" rx="1.1" fill="white"/>
                <circle cx="19" cy="6"  r="1.6" fill="white"/>
              </svg>
            </div>
            <span className="text-[20px] font-bold text-text-primary tracking-tight">CallGuard <span className="text-primary">AI</span></span>
          </div>
          <nav className="flex items-center gap-6 text-table-cell">
            <a href="#features" className="text-text-secondary hover:text-text-primary">Features</a>
            <a href="#pricing" className="text-text-secondary hover:text-text-primary">Pricing</a>
            <Link to="/login" className="text-text-secondary hover:text-text-primary">Sign In</Link>
            <a
              href="#demo"
              className="bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
            >
              Request Demo
            </a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 py-24 text-center">
        <div className="inline-block px-3 py-1 rounded-[20px] bg-primary-light text-pass text-[12px] font-semibold uppercase tracking-wider mb-6">
          AI-Powered Call Quality Assurance
        </div>
        <h1 className="text-[40px] md:text-[56px] font-bold text-text-primary leading-[1.1] tracking-tight">
          100% of calls, scored in under 5 minutes.
        </h1>
        <p className="text-[18px] text-text-subtle mt-6 leading-relaxed max-w-2xl mx-auto">
          CallGuard transcribes and evaluates every customer call against your compliance scorecard -
          automatically. Replace spot-check QA with complete coverage. Catch breaches in hours, not weeks.
        </p>
        <div className="flex items-center justify-center gap-3 mt-10">
          <a
            href="#demo"
            className="bg-primary text-white px-6 py-3 rounded-btn text-[15px] font-semibold hover:bg-primary-hover transition-colors"
          >
            Request Demo
          </a>
          <Link
            to="/login"
            className="px-6 py-3 rounded-btn border border-border text-text-cell text-[15px] font-semibold hover:bg-white transition-colors"
          >
            Sign In
          </Link>
        </div>
      </section>

      {/* Problem */}
      <section className="max-w-5xl mx-auto px-6 pb-16">
        <h2 className="text-[28px] font-bold text-text-primary text-center mb-2">The compliance problem</h2>
        <p className="text-page-sub text-text-subtle text-center mb-10">Manual call QA doesn't scale - and regulators know it</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ProblemCard
            value="2-5%"
            label="Of calls QA'd manually"
            detail="Most compliance teams sample only a tiny fraction of calls. The rest are invisible."
          />
          <ProblemCard
            value="41 days"
            label="Avg breach detection"
            detail="By the time a manual review finds a compliance failure, the client may already have complained."
          />
          <ProblemCard
            value="£16k"
            label="Avg FOS redress"
            detail="Per upheld complaint. And FCA enforcement against advice firms is accelerating year-on-year."
          />
        </div>
      </section>

      {/* How it works */}
      <section className="bg-white py-20 border-y border-border">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-[28px] font-bold text-text-primary text-center mb-2">How CallGuard changes that</h2>
          <p className="text-page-sub text-text-subtle text-center mb-10">From call to compliance insight in minutes</p>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <StepCard n="01" title="Ingest" body="API webhook, SFTP, or manual upload. Works with your existing dialler or CRM." />
            <StepCard n="02" title="Transcribe" body="Speaker-diarised transcripts in under 90 seconds. Low-latency STT tuned for call audio." />
            <StepCard n="03" title="Score" body="AI evaluates against your compliance scorecard with evidence quotes and reasoning per criterion." />
            <StepCard n="04" title="Act" body="Real-time alerts to email/Slack for critical breaches. Triage via the breach register." />
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-[28px] font-bold text-text-primary text-center mb-2">Everything compliance needs</h2>
        <p className="text-page-sub text-text-subtle text-center mb-10">A complete QA governance tool, not just a dashboard</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <FeatureCard title="Compliance Scorecards" body="Customisable per advice type. Import from CSV. Claude-powered evaluation with evidence quotes." />
          <FeatureCard title="Breach Register" body="Every failed item becomes a trackable breach. Status workflow. FCA supervisory-ready CSV and PDF export." />
          <FeatureCard title="Adviser Risk Profile" body="Triage view: who needs supervision, who needs coaching, who to leave alone. Recommended actions per adviser." />
          <FeatureCard title="Real-Time Alerts" body="Email, Slack, or in-app alerts fire the moment a critical breach is detected. Configurable per rule." />
          <FeatureCard title="API + SFTP Ingestion" body="Push calls in from any telephony or dialler platform. Webhook or SFTP pull. Zero-lift integration." />
          <FeatureCard title="Client Share Links" body="Send your client a signed URL showing their call's compliance summary. Consumer Duty forward-leaning." />
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="bg-white py-20 border-y border-border">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-[28px] font-bold text-text-primary text-center mb-2">Simple pricing</h2>
          <p className="text-page-sub text-text-subtle text-center mb-10">All plans include custom scorecard build, onboarding, and Consumer Duty reporting</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <PricingCard
              tier="Starter"
              price="£199"
              description="Sole-trader IFAs and small practices"
              features={['500 calls/month', 'Up to 10 advisers', '1 custom scorecard', 'Compliance dashboard', 'Breach register']}
            />
            <PricingCard
              tier="Growth"
              price="£499"
              description="10-50 adviser firms"
              featured
              features={['2,000 calls/month', 'Up to 50 advisers', '5 scorecards by advice type', 'CRM integrations', 'Custom alert rules', 'Intelliflo integration']}
            />
            <PricingCard
              tier="Pro"
              price="£999"
              description="Multi-site networks"
              features={['5,000 calls/month', 'Up to 200 advisers', 'Unlimited scorecards', 'T&C scheme integration', 'Dedicated specialist', '99.9% uptime SLA']}
            />
          </div>
        </div>
      </section>

      {/* Demo Form */}
      <section id="demo" className="max-w-2xl mx-auto px-6 py-20">
        <h2 className="text-[28px] font-bold text-text-primary text-center mb-2">Request a demo</h2>
        <p className="text-page-sub text-text-subtle text-center mb-8">
          See CallGuard running on real calls. We'll walk you through how it applies to your specific compliance scorecard.
        </p>
        <DemoForm />
      </section>

      {/* Footer */}
      <footer className="bg-white border-t border-border py-8">
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4 text-[12px] text-text-muted">
          <div>
            &copy; {new Date().getFullYear()} CallGuard. UK-based. UK data residency. AES-256 encryption at rest.
          </div>
          <div className="flex gap-4">
            <Link to="/login" className="hover:text-text-primary">Sign In</Link>
            <a href="#demo" className="hover:text-text-primary">Request Demo</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ProblemCard({ value, label, detail }: { value: string; label: string; detail: string }) {
  return (
    <div className="bg-white border border-border rounded-card p-6">
      <div className="text-[36px] font-bold text-fail font-mono">{value}</div>
      <div className="text-[13px] font-semibold text-text-primary mt-1">{label}</div>
      <div className="text-table-cell text-text-subtle mt-2 leading-relaxed">{detail}</div>
    </div>
  );
}

function StepCard({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="text-center">
      <div className="w-10 h-10 rounded-full bg-primary-light text-pass font-bold mx-auto flex items-center justify-center font-mono">
        {n}
      </div>
      <h3 className="text-[15px] font-semibold text-text-primary mt-4">{title}</h3>
      <p className="text-table-cell text-text-subtle mt-2 leading-relaxed">{body}</p>
    </div>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white border border-border rounded-card p-6 hover:border-primary hover:shadow-md transition-all">
      <h3 className="text-[15px] font-semibold text-text-primary">{title}</h3>
      <p className="text-table-cell text-text-subtle mt-2 leading-relaxed">{body}</p>
    </div>
  );
}

function PricingCard({
  tier,
  price,
  description,
  features,
  featured,
}: {
  tier: string;
  price: string;
  description: string;
  features: string[];
  featured?: boolean;
}) {
  return (
    <div
      className={`rounded-card p-6 border ${
        featured ? 'border-primary shadow-lg bg-white ring-2 ring-primary/20' : 'border-border bg-white'
      }`}
    >
      {featured && (
        <div className="inline-block text-[11px] font-semibold uppercase tracking-wider text-pass bg-primary-light px-2 py-0.5 rounded mb-2">
          Most popular
        </div>
      )}
      <h3 className="text-[18px] font-bold text-text-primary">{tier}</h3>
      <p className="text-table-cell text-text-subtle mt-0.5">{description}</p>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-[36px] font-bold text-text-primary">{price}</span>
        <span className="text-table-cell text-text-muted">/month</span>
      </div>
      <ul className="mt-6 space-y-2 text-table-cell text-text-cell">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M5 13l4 4L19 7" />
            </svg>
            {f}
          </li>
        ))}
      </ul>
      <a
        href="#demo"
        className={`mt-6 block text-center py-2.5 rounded-btn font-semibold text-table-cell transition-colors ${
          featured
            ? 'bg-primary text-white hover:bg-primary-hover'
            : 'border border-border text-text-cell hover:bg-sidebar-hover'
        }`}
      >
        Request Demo
      </a>
    </div>
  );
}

function DemoForm() {
  const [form, setForm] = useState({
    name: '',
    email: '',
    company: '',
    call_volume: '',
    message: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/public/demo-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.message || 'Something went wrong');
      }
      setSuccess(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="bg-pass-bg border border-pass/20 rounded-card p-8 text-center">
        <div className="text-[18px] font-semibold text-pass mb-1">Thanks - we'll be in touch shortly.</div>
        <p className="text-table-cell text-text-subtle">
          Expect a reply within one business day. In the meantime,{' '}
          <Link to="/login" className="text-primary font-semibold hover:underline">
            sign in
          </Link>{' '}
          if you already have an account.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-border rounded-card p-6 space-y-4">
      {error && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">{error}</div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Name">
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Work Email">
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Company">
          <input
            type="text"
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Monthly Call Volume">
          <select
            value={form.call_volume}
            onChange={(e) => setForm({ ...form, call_volume: e.target.value })}
            className={inputCls}
          >
            <option value="">Select...</option>
            <option value="<500">Under 500</option>
            <option value="500-2000">500 - 2,000</option>
            <option value="2000-5000">2,000 - 5,000</option>
            <option value="5000+">5,000+</option>
          </select>
        </Field>
      </div>
      <Field label="Anything specific you'd like to see?">
        <textarea
          rows={3}
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          className={inputCls}
        />
      </Field>
      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-primary text-white px-6 py-3 rounded-btn font-semibold text-[15px] hover:bg-primary-hover disabled:opacity-50 transition-colors"
      >
        {submitting ? 'Submitting...' : 'Request Demo'}
      </button>
      <p className="text-[11px] text-text-muted text-center">
        We'll only use your details to get in touch about CallGuard.
      </p>
    </form>
  );
}

const inputCls =
  'w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary bg-white';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] text-text-muted mb-1">{label}</label>
      {children}
    </div>
  );
}
