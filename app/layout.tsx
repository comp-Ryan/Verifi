import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'Verifi - Live Diligence Transcription',
  description: 'Live diligence tool that listens to a founder\'s pitch and transcribes it in real time using the Gemini Live API.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
