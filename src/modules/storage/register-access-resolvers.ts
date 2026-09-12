/**
 * Barrel that registers every module's file access / upload target resolvers
 * with the storage layer. Import it from any route that serves or accepts
 * files so purposes owned by other modules (recordings, documents, media…)
 * are recognized.
 */
import '@/modules/storage/storage-access';
import '@/modules/copilot/knowledge-service';
import '@/modules/voice/voice-access';
import '@/modules/comms/comms-storage';
