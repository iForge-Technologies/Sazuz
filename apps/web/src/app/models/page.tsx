import type { Metadata } from 'next';
import { ModelCenter } from '../../components/model-center';

export const metadata: Metadata = {
  title: 'Models · Sazuz',
  description: 'Model connections, discovery, roles and usage prices.',
};

export default function ModelsPage() {
  return <ModelCenter />;
}
