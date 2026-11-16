import type {
  PreparationProgress,
  ProviderTechnicalMetadata,
} from '../providers/types';

export type WorkerInboundMessage =
  | {
      type: 'prepare';
      requestId: string;
    }
  | {
      type: 'generate';
      requestId: string;
      imageBlob: Blob;
      prompt: string;
    }
  | {
      type: 'cancel';
      requestId: string;
    }
  | {
      type: 'dispose';
    };

export type WorkerOutboundMessage =
  | {
      type: 'prepare-progress';
      requestId: string;
      progress: PreparationProgress;
    }
  | {
      type: 'prepare-complete';
      requestId: string;
      preparationMs: number;
      details: ProviderTechnicalMetadata;
    }
  | {
      type: 'generate-chunk';
      requestId: string;
      delta: string;
    }
  | {
      type: 'generate-complete';
      requestId: string;
      text: string;
      firstTextMs: number | null;
      totalLatencyMs: number;
      details: ProviderTechnicalMetadata;
    }
  | {
      type: 'cancelled';
      requestId: string;
    }
  | {
      type: 'error';
      requestId: string;
      phase: 'prepare' | 'generate' | 'dispose';
      message: string;
    }
  | {
      type: 'disposed';
    };
