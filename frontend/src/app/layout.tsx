import './globals.css';
import { AuthProvider } from '@/lib/auth-context';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'CloudVault',
  description: 'Your secure cloud storage solution',
};

import { NotificationProvider } from '@/components/NotificationProvider';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased bg-gray-950 text-gray-100 min-h-screen">
        <AuthProvider>
          <NotificationProvider>
            {children}
          </NotificationProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
