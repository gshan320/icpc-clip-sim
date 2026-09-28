import type { FlowModel } from '../physics/flow';
import type { Hemodynamics } from '../physics/hemodynamics';
import type { IcgAngiography } from '../physics/icg';
import type { EndoscopeView } from '../scene/endoscopeView';
import { AneurysmClipTool } from './aneurysmClip';
import { BipolarTool } from './bipolar';
import { DissectorTool } from './dissector';
import { DopplerTool } from './doppler';
import { EndoscopeTool } from './endoscopeTool';
import { IcgTool } from './icgTool';
import type { ToolManager } from './manager';
import { ScissorsTool } from './scissors';
import { SpatulaTool } from './spatulaTool';
import { SuctionTool } from './suction';
import { TempClipTool } from './tempClip';
import type { ToolContext } from './tool';

export interface ToolDeps {
  flow: FlowModel;
  engine: Hemodynamics;
  icg: IcgAngiography;
  endoscope: EndoscopeView;
  onEndoscope: (on: boolean) => void;
}

/** All instruments in toolbar order (keys 1…9, 0). */
export function registerTools(manager: ToolManager, ctx: ToolContext, d: ToolDeps) {
  manager.register(new SuctionTool(ctx));
  manager.register(new ScissorsTool(ctx));
  manager.register(new BipolarTool(ctx));
  manager.register(new DissectorTool(ctx));
  manager.register(new SpatulaTool(ctx));
  manager.register(new AneurysmClipTool(ctx, d.flow));
  manager.register(new IcgTool(ctx, d.icg));
  manager.register(new DopplerTool(ctx, d.flow, d.engine));
  manager.register(new EndoscopeTool(ctx, d.endoscope, d.onEndoscope));
  manager.register(new TempClipTool(ctx));
}
