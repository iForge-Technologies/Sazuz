import { notFound } from 'next/navigation';
import { SetupWizard } from '../../components/setup-wizard';
export default async function SetupPage() {
  let completed: boolean;
  try {
    const response = await fetch(
      new URL('/api/setup/status', process.env.SAZUZ_SERVER_URL ?? 'http://127.0.0.1:7778'),
      { cache: 'no-store', signal: AbortSignal.timeout(3000) },
    );
    const body: unknown = await response.json();
    completed =
      response.ok &&
      typeof body === 'object' &&
      body !== null &&
      'completed' in body &&
      body.completed === true;
  } catch {
    completed = false;
  }
  if (completed) notFound();
  return <SetupWizard />;
}
