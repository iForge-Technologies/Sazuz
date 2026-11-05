import Link from 'next/link';
import { citationParts } from '../lib/citations';

export function CitedText({ text }: { text: string }) {
  return citationParts(text).map((part, index) =>
    part.id ? (
      <Link key={index} href={`/knowledge/chunks/${part.id}`} title="Open source chunk">
        {part.text}
      </Link>
    ) : (
      part.text
    ),
  );
}
