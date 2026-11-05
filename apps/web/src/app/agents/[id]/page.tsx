import { AgentCenter } from '../../../components/agent-center';
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentCenter id={id} />;
}
