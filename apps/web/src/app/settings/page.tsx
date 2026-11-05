import { SettingsCenter } from '../../components/settings-center';
import { namespaceSchema } from '@sazuz/config/settings';
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; oauth?: string }>;
}) {
  const values = await searchParams;
  const section = namespaceSchema.safeParse(values.section);
  const oauthOutcome =
    values.oauth === 'connected' || values.oauth === 'failed' ? values.oauth : undefined;
  return (
    <SettingsCenter
      initialNamespace={section.success ? section.data : 'general'}
      {...(oauthOutcome ? { oauthOutcome } : {})}
    />
  );
}
