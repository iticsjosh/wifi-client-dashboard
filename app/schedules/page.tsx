import Link from 'next/link';
import { getSchedules } from '../actions';
import SchedulesList from '@/components/SchedulesList';
import type { Schedule } from '@/lib/types';

export const revalidate = 0;

export default async function SchedulesPage() {
  let schedules: Schedule[] = [];
  let fetchError: string | null = null;

  try {
    schedules = await getSchedules();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : 'Failed to load schedules.';
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-screen-xl mx-auto">
          <h1 className="text-xl font-semibold text-gray-900">Schedules</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Pending and past scheduled actions ·{' '}
            <Link href="/" className="text-blue-600 hover:text-blue-800">
              Back to clients
            </Link>
          </p>
        </div>
      </header>

      <div className="max-w-screen-xl mx-auto px-6 py-6">
        {fetchError ? (
          <div className="bg-red-50 border border-red-200 rounded-lg px-5 py-4 text-sm text-red-700">
            <strong className="font-medium">Could not load schedules:</strong> {fetchError}
          </div>
        ) : (
          <SchedulesList initial={schedules} />
        )}
      </div>
    </main>
  );
}
