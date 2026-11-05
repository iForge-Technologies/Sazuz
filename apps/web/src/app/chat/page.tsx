import type { Metadata } from 'next';
import { ChatWorkspace } from '../../components/chat-workspace';

export const metadata: Metadata = {
  title: 'Chat · Sazuz',
  description: 'Your project conversations, model usage and tool activity.',
};

export default function ChatPage() {
  return <ChatWorkspace />;
}
