import signals from "signals";
import c3d from '../build/Release/c3d.node';
import { AbstractDialog } from "../command/AbstractDialog";
import Command from '../command/Command';
import { Viewport } from '../components/viewport/Viewport';
import { HasSelection, Selectable, ToggleableSet } from '../selection/SelectionDatabase';
import { Agent } from './GeometryDatabase';
import { Replacement } from './ModifierManager';
import * as visual from '../visual_model/VisualModel';

export class EditorSignals {
    objectAdded: signals.Signal<[visual.Item, Agent]> = new signals.Signal();
    objectRemoved: signals.Signal<[visual.Item, Agent]> = new signals.Signal();
    objectReplaced: signals.Signal<Replacement> = new signals.Signal();
    objectHidden: signals.Signal<visual.Item> = new signals.Signal();
    objectUnhidden: signals.Signal<visual.Item> = new signals.Signal();
    objectSelected: signals.Signal<Selectable> = new signals.Signal();
    objectDeselected: signals.Signal<Selectable> = new signals.Signal();
    objectHovered: signals.Signal<Selectable> = new signals.Signal();
    objectUnhovered: signals.Signal<Selectable> = new signals.Signal();
    selectionChanged: signals.Signal<{ selection: HasSelection, point?: THREE.Vector3 }> = new signals.Signal();
    hoverChanged: signals.Signal<{ added: Set<Selectable>,removed: Set<Selectable> }> = new signals.Signal();
    sceneGraphChanged: signals.Signal = new signals.Signal();
    modifiersLoaded: signals.Signal = new signals.Signal();
    snapped: signals.Signal<{ position: THREE.Vector3, names: string[] } | undefined> = new signals.Signal();
    factoryUpdated: signals.Signal = new signals.Signal();
    factoryUpdateFailed: signals.Signal<any> = new signals.Signal();
    factoryCommitted: signals.Signal = new signals.Signal();
    factoryCancelled: signals.Signal = new signals.Signal();
    pointPickerChanged: signals.Signal = new signals.Signal();
    gizmoChanged: signals.Signal = new signals.Signal();
    windowResized: signals.Signal = new signals.Signal();
    windowLoaded: signals.Signal = new signals.Signal();
    renderPrepared: signals.Signal<{ camera: THREE.Camera, resolution: THREE.Vector2 }> = new signals.Signal();
    commandStarted: signals.Signal<Command> = new signals.Signal();
    commandFinishedSuccessfully: signals.Signal<Command> = new signals.Signal();
    commandEnded: signals.Signal<Command> = new signals.Signal();
    keybindingsRegistered: signals.Signal<string[]> = new signals.Signal();
    keybindingsCleared: signals.Signal<string[]> = new signals.Signal();
    hovered: signals.Signal<THREE.Intersection[]> = new signals.Signal();
    historyChanged: signals.Signal = new signals.Signal();
    contoursChanged: signals.Signal<visual.SpaceInstance<visual.Curve3D>> = new signals.Signal();
    creatorChanged: signals.Signal<{ creator: c3d.Creator, item: visual.Item }> = new signals.Signal();
    dialogAdded: signals.Signal<AbstractDialog<any>> = new signals.Signal();
    dialogRemoved: signals.Signal = new signals.Signal();
    viewportActivated: signals.Signal<Viewport> = new signals.Signal();
    moduleReloaded: signals.Signal = new signals.Signal();
    selectionModeChanged: signals.Signal<ToggleableSet> = new signals.Signal();
}