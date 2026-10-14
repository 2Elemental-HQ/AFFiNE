import { OnEvent, Service } from '@toeverything/infra';
import { distinctUntilChanged } from 'rxjs';

import type { FeatureFlagService } from '../../feature-flag';
import { ApplicationStarted } from '../../lifecycle';
import { setMermaidWasmNativeRendererEnabled } from '../runtime-config';

@OnEvent(ApplicationStarted, e => e.syncFlag)
export class PreviewRendererFeatureSyncService extends Service {
  constructor(private readonly featureFlagService: FeatureFlagService) {
    super();
  }

  syncFlag() {
    setMermaidWasmNativeRendererEnabled(false);
  }
}
