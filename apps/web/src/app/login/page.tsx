'use client';
import { LoginForm } from '../../components/account-controls';
import { SazuzMark } from '../../components/icons';
export default function LoginPage() {
  return (
    <main className="setup-shell auth-shell">
      <aside className="auth-introduction">
        <a href="/" className="auth-brand">
          <SazuzMark />
          Sazuz
        </a>
        <div className="auth-statement">
          <p className="eyebrow">YOUR AUTONOMOUS WORKSPACE</p>
          <h2>
            Your workspace
            <br />
            for autonomous work.
          </h2>
          <p>Bring your models, connect your tools, and stay close to the work your agents do.</p>
        </div>
        <p className="auth-footnote">Sazuz · Self-hosted, model-agnostic</p>
      </aside>
      <section className="setup-card login-card" aria-labelledby="login-title">
        <p className="eyebrow">SIGN IN</p>
        <h1 id="login-title">Welcome back</h1>
        <p>Sign in to your workspace.</p>
        <LoginForm
          onSignedIn={() => {
            window.location.assign('/settings');
          }}
        />
        <a className="auth-health-link" href="/health">
          View system health ↗
        </a>
      </section>
    </main>
  );
}
