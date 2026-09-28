import { useSyncExternalStore } from 'react';

import { snapshot, subscribe, type QueueItem } from '@/api/uploadQueue';

/** The offline queue, live. */
export const useQueue = (): QueueItem[] => useSyncExternalStore(subscribe, snapshot, snapshot);
