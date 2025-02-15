import * as THREE from 'three';
import c3d from '../../build/Release/c3d.node';
import { Measure } from "../components/stats/Measure";
import { unit } from '../util/Conversion';
import { SequentialExecutor } from '../util/SequentialExecutor';
import { GConstructor } from '../util/Util';
import * as visual from '../visual_model/VisualModel';
import * as build from '../visual_model/VisualModelBuilder';
import { Agent, ControlPointData, DatabaseLike, MaterialOverride, TemporaryObject, TopologyData } from './DatabaseLike';
import { EditorSignals } from './EditorSignals';
import { GeometryMemento, MementoOriginator } from './History';
import MaterialDatabase from './MaterialDatabase';
import { MeshCreator } from './MeshCreator';
import { Nodes } from './Nodes';
import { SolidCopier, SolidCopierPool } from './SolidCopier';
import { TypeManager } from './TypeManager';

const mesh_precision_distance: [number, number][] = [[unit(0.05), 1000], [unit(0.001), 1]];
const other_precision_distance: [number, number][] = [[unit(0.0005), 1]];
const temporary_precision_distance: [number, number][] = [[unit(0.004), 1]];
const formNote = new c3d.FormNote(true, true, false, false, false);

type Builder = build.SpaceInstanceBuilder<visual.Curve3D | visual.Surface> | build.PlaneInstanceBuilder<visual.Region> | build.SolidBuilder;

export class GeometryDatabase implements DatabaseLike, MementoOriginator<GeometryMemento> {
    readonly queue = new SequentialExecutor();
    readonly types = new TypeManager(this.signals);

    readonly temporaryObjects = new THREE.Scene();
    readonly phantomObjects = new THREE.Scene();

    private readonly geometryModel = new Map<c3d.SimpleName, { view: visual.Item, model: c3d.Item }>();
    private readonly version2name = new Map<c3d.SimpleName, c3d.SimpleName>();
    private readonly name2version = new Map<c3d.SimpleName, c3d.SimpleName>();
    private readonly automatics = new Set<c3d.SimpleName>();
    private readonly topologyModel = new Map<string, TopologyData>();
    private readonly controlPointModel = new Map<string, ControlPointData>();

    readonly nodes = new Nodes(this, this.materials, this.signals);

    constructor(
        private readonly meshCreator: MeshCreator,
        private readonly copier: SolidCopier,
        private readonly materials: MaterialDatabase,
        private readonly signals: EditorSignals
    ) { }

    private positiveCounter = 1; // ids must be positive to distinguish real objects from temps/phantoms
    private negativeCounter = -1;

    get version() { return this.positiveCounter }

    async addItem(model: c3d.Solid, agent?: Agent, name?: c3d.SimpleName): Promise<visual.Solid>;
    async addItem(model: c3d.SpaceInstance, agent?: Agent, name?: c3d.SimpleName): Promise<visual.SpaceInstance<visual.Curve3D>>;
    async addItem(model: c3d.PlaneInstance, agent?: Agent, name?: c3d.SimpleName): Promise<visual.PlaneInstance<visual.Region>>;
    async addItem(model: c3d.Item, agent?: Agent, name?: c3d.SimpleName): Promise<visual.Item>;
    async addItem(model: c3d.Item, agent: Agent = 'user', name?: c3d.SimpleName): Promise<visual.Item> {
        return this.queue.enqueue(async () => {
            const result = await this.insertItem(model, agent, name);
            this.version2name.set(result.simpleName, result.simpleName);
            this.name2version.set(result.simpleName, result.simpleName);
            return result;
        });
    }

    async replaceItem(from: visual.Solid, model: c3d.Solid, agent?: Agent): Promise<visual.Solid>;
    async replaceItem<T extends visual.SpaceItem>(from: visual.SpaceInstance<T>, model: c3d.SpaceInstance, agent?: Agent): Promise<visual.SpaceInstance<visual.Curve3D>>;
    async replaceItem<T extends visual.PlaneItem>(from: visual.PlaneInstance<T>, model: c3d.PlaneInstance, agent?: Agent): Promise<visual.PlaneInstance<visual.Region>>;
    async replaceItem(from: visual.Item, model: c3d.Item, agent?: Agent): Promise<visual.Item>;
    async replaceItem(from: visual.Item, model: c3d.Item): Promise<visual.Item> {
        return this.queue.enqueue(async () => {
            const to = await this.insertItem(model, 'user');
            this._removeItem(from, 'user');
            const name = this.version2name.get(from.simpleName)!;
            this.version2name.delete(from.simpleName);
            this.version2name.set(to.simpleName, name);
            this.name2version.set(name, to.simpleName);
            return to;
        });
    }

    async removeItem(view: visual.Item, agent: Agent = 'user'): Promise<void> {
        return this.queue.enqueue(async () => {
            const result = await this._removeItem(view, agent);
            this.nodes.delete(view.simpleName);
            const old = this.version2name.get(view.simpleName)!;
            this.version2name.delete(view.simpleName);
            this.name2version.delete(old);
            return result;
        });
    }

    private async insertItem(model: c3d.Item, agent: Agent, name?: c3d.SimpleName): Promise<visual.Item> {
        if (name === undefined) name = this.positiveCounter++;
        else (this.positiveCounter = Math.max(this.positiveCounter, name + 1));

        const builder = await this.meshes(model, name, this.precisionAndDistanceFor(model), true); // TODO: it would be nice to move this out of the queue but tests fail
        const view = builder.build(name, this.topologyModel, this.controlPointModel);
        view.userData.simpleName = name;

        this.geometryModel.set(name, { view, model });
        if (agent === 'automatic') this.automatics.add(name);

        this.signals.sceneGraphChanged.dispatch();
        this.signals.objectAdded.dispatch([view, agent]);
        return view;
    }

    private precisionAndDistanceFor(item: c3d.Item, mode: 'real' | 'temporary' = 'real'): [number, number][] {
        if (item.IsA() === c3d.SpaceType.Solid) {
            return mode === 'real' ? mesh_precision_distance : temporary_precision_distance;
        } else {
            return other_precision_distance;
        }
    }

    async addPhantom(object: c3d.Item, materials?: MaterialOverride): Promise<TemporaryObject> {
        return this.addTemporaryItem(object, undefined, materials, this.phantomObjects);
    }

    async replaceWithTemporaryItem(from: visual.Item, to: c3d.Item,): Promise<TemporaryObject> {
        return this.addTemporaryItem(to, from);
    }

    optimization<T>(from: visual.Item, fast: () => T, ifDisallowed: () => T): T {
        return fast();
    }

    async addTemporaryItem(model: c3d.Item, ancestor?: visual.Item, materials?: MaterialOverride, into = this.temporaryObjects): Promise<TemporaryObject> {
        const { signals } = this;
        const tempId = this.negativeCounter--;
        const builder = await this.meshes(
            model,
            tempId,
            this.precisionAndDistanceFor(model, 'temporary'),
            false,
            materials);
        const view = builder.build(tempId);
        into.add(view);
        // TODO: find a more elegant way to do this
        if (into === this.temporaryObjects) {
            const material = ancestor !== undefined ? this.nodes.getMaterial(ancestor) : undefined;
            this.signals.temporaryObjectAdded.dispatch({ view, material });
        }

        view.visible = false;
        return {
            underlying: view,
            show() {
                view.visible = true;
                if (ancestor !== undefined) ancestor.visible = false;
            },
            hide() {
                view.visible = false;
                if (ancestor !== undefined) ancestor.visible = true;
            },
            cancel() {
                view.dispose();
                into.remove(view);
                if (ancestor !== undefined) ancestor.visible = true;
                signals.objectRemoved.dispatch([view, 'automatic']);
            }
        }
    }

    clearTemporaryObjects() {
        this.temporaryObjects.clear();
        this.phantomObjects.clear();
    }

    private async _removeItem(view: visual.Item, agent: Agent = 'user') {
        const simpleName = view.simpleName;
        this.geometryModel.delete(simpleName);
        this.removeTopologyItems(view);
        this.removeControlPoints(view);
        this.automatics.delete(simpleName);

        this.signals.objectRemoved.dispatch([view, agent]);
        this.signals.sceneGraphChanged.dispatch();
    }

    lookupItemById(id: c3d.SimpleName): { view: visual.Item, model: c3d.Item } {
        const result = this.geometryModel.get(id)
        if (result === undefined) throw new Error(`invalid precondition: object ${id} missing from geometry model`);
        return result;
    }

    lookup(object: visual.Solid): c3d.Solid;
    lookup(object: visual.SpaceInstance<visual.Curve3D>): c3d.SpaceInstance;
    lookup(object: visual.PlaneInstance<visual.Region>): c3d.PlaneInstance;
    lookup(object: visual.Item): c3d.Item;
    lookup(object: visual.Item): c3d.Item {
        return this.lookupItemById(object.simpleName).model;
    }

    hasTopologyItem(id: string): boolean {
        return this.topologyModel.has(id);
    }

    lookupTopologyItemById(id: string): TopologyData {
        const result = this.topologyModel.get(id);
        if (result === undefined) throw new Error(`invalid precondition: object ${id} missing from topology model`);
        return result;
    }

    lookupTopologyItem(object: visual.Face): c3d.Face;
    lookupTopologyItem(object: visual.CurveEdge): c3d.CurveEdge;
    lookupTopologyItem(object: visual.Edge | visual.Face): c3d.TopologyItem {
        return this.lookupTopologyItemById(object.simpleName).model;
    }

    find<T extends visual.PlaneInstance<visual.Region>>(klass: GConstructor<T>, includeAutomatics?: boolean): { view: T, model: c3d.PlaneInstance }[];
    find<T extends visual.SpaceInstance<visual.Curve3D>>(klass: GConstructor<T>, includeAutomatics?: boolean): { view: T, model: c3d.SpaceInstance }[];
    find<T extends visual.Solid>(klass: GConstructor<T>, includeAutomatics?: boolean): { view: T, model: c3d.Solid }[];
    find<T extends visual.Solid>(klass: undefined, includeAutomatics?: boolean): { view: T, model: c3d.Solid }[];
    find<T extends visual.Item>(klass?: GConstructor<T>, includeAutomatics?: boolean): { view: T, model: c3d.Item }[] {
        const automatics = this.automatics;
        const result: { view: visual.Item, model: c3d.Item }[] = [];
        if (klass === undefined) {
            for (const [id, { view, model }] of this.geometryModel.entries()) {
                if (!includeAutomatics && automatics.has(id)) continue;
                result.push({ view, model });
            }
        } else {
            for (const [id, { view, model }] of this.geometryModel.entries()) {
                if (!includeAutomatics && automatics.has(id)) continue;
                if (view instanceof klass) result.push({ view, model });
            }
        }
        return result as { view: T, model: c3d.Item }[];
    }

    findAll(includeAutomatics?: boolean): { view: visual.Item, model: c3d.Solid }[] {
        return this.find(undefined, includeAutomatics);
    }


    async duplicate(model: visual.Solid): Promise<visual.Solid>;
    async duplicate<T extends visual.SpaceItem>(model: visual.SpaceInstance<T>): Promise<visual.SpaceInstance<T>>;
    async duplicate<T extends visual.PlaneItem>(model: visual.PlaneInstance<T>): Promise<visual.PlaneInstance<T>>;
    async duplicate(edge: visual.CurveEdge): Promise<visual.SpaceInstance<visual.Curve3D>>;
    async duplicate(item: visual.Item | visual.CurveEdge): Promise<visual.Item> {
        if (item instanceof visual.Item) {
            const model = this.lookup(item);
            const dup = model.Duplicate().Cast<c3d.Item>(model.IsA());
            return this.addItem(dup); // FIXME: we shouldn't duplicate the geometry
        } else if (item instanceof visual.TopologyItem) {
            const edge = this.lookupTopologyItem(item);
            const curve = edge.MakeCurve()!;
            return this.addItem(new c3d.SpaceInstance(curve));
        } else throw new Error("unsupported duplication");
    }

    get visibleObjects(): visual.Item[] {
        const { geometryModel, nodes, types } = this;
        const difference = [];
        for (const { view } of geometryModel.values()) {
            if (nodes.isHidden(view)) continue;
            if (!nodes.isVisible(view)) continue;
            if (!types.isEnabled(view)) continue;
            difference.push(view);
        }
        return difference;
    }

    get selectableObjects(): visual.Item[] {
        const { nodes } = this;
        return this.visibleObjects.filter(i => nodes.isSelectable(i));
    }

    private async meshes(obj: c3d.Item, id: c3d.SimpleName, precision_distance: [number, number][], includeMetadata: boolean, materials?: MaterialOverride): Promise<build.Builder<visual.SpaceInstance<visual.Curve3D | visual.Surface> | visual.Solid | visual.PlaneInstance<visual.Region>>> {
        let builder;
        switch (obj.IsA()) {
            case c3d.SpaceType.SpaceInstance:
                builder = new build.SpaceInstanceBuilder<visual.Curve3D | visual.Surface>();
                break;
            case c3d.SpaceType.PlaneInstance:
                builder = new build.PlaneInstanceBuilder<visual.Region>();
                break;
            case c3d.SpaceType.Solid:
                builder = new build.SolidBuilder();
                break;
            default:
                throw new Error(`type ${c3d.SpaceType[obj.IsA()]} not yet supported`);
        }

        const promises = [];
        for (const [precision, distance] of precision_distance) {
            promises.push(this.object2mesh(builder, obj, id, precision, distance, includeMetadata, materials));
        }
        await Promise.all(promises);

        return builder;
    }

    private async object2mesh(builder: Builder, obj: c3d.Item, id: c3d.SimpleName, sag: number, distance: number, includeMetadata: boolean, materials?: MaterialOverride): Promise<void> {
        const stepData = new c3d.StepData(c3d.StepType.SpaceStep, sag);
        const stats = Measure.get("create-mesh");
        stats.begin();
        const item = await this.meshCreator.create(obj, stepData, formNote, obj.IsA() === c3d.SpaceType.Solid, includeMetadata);
        stats.end();

        switch (obj.IsA()) {
            case c3d.SpaceType.SpaceInstance: {
                const instance = obj as c3d.SpaceInstance;
                const underlying = instance.GetSpaceItem();
                if (underlying === null) throw new Error("invalid precondition");
                switch (underlying.Family()) {
                    case c3d.SpaceType.Curve3D:
                        builder = builder as build.SpaceInstanceBuilder<visual.Curve3D>;
                        if (item.edges.length === 0) throw new Error(`invalid precondition: no edges`);

                        const lineMaterial = materials?.line ?? this.materials.line(instance);
                        const pointMaterial = materials?.controlPoint ?? this.materials.controlPoint();

                        const segments = new build.CurveSegmentGroupBuilder();
                        for (const edge of item.edges) {
                            segments.add(edge, id, materials?.line ?? lineMaterial, materials?.lineDashed ?? this.materials.lineDashed());
                        }

                        const points = build.ControlPointGroupBuilder.build(underlying, id, pointMaterial);
                        const curve = visual.Curve3D.build(segments, points);
                        builder.add(curve, distance);
                        break;
                    case c3d.SpaceType.Surface:
                        builder = builder as build.SpaceInstanceBuilder<visual.Surface>;
                        if (item.faces.length != 1) throw new Error("Invalid precondition");
                        const grid = item.faces[0];
                        const material = materials?.surface ?? this.materials.surface(instance);
                        const surface = visual.Surface.build(grid, material);
                        builder.add(surface, distance);
                        break;
                    default: throw new Error("invalid precondition")
                }
                break;
            }
            case c3d.SpaceType.PlaneInstance: {
                const instance = builder as build.PlaneInstanceBuilder<visual.Region>;
                if (item.faces.length != 1) throw new Error("Invalid precondition: grid with length: " + item.faces.length);
                const grid = item.faces[0];
                const material = materials?.region ?? this.materials.region();
                instance.add(grid, material);
                break;
            }
            // case c3d.SpaceType.Point3D: {
            //     const apexes = mesh.GetApexes();
            //     const geometry = new THREE.BufferGeometry();
            //     geometry.setAttribute('position', new THREE.Float32BufferAttribute(apexes, 3));
            //     const points = new THREE.Points(geometry, this.materials.point(obj));
            //     return points;
            // }
            case c3d.SpaceType.Solid: {
                const solid = builder as build.SolidBuilder;
                const edges = new build.CurveEdgeGroupBuilder();
                const lineMaterial = materials?.line ?? this.materials.line();
                const lineDashed = this.materials.lineDashed();
                for (const edge of item.edges) {
                    edges.add(edge, id, lineMaterial, lineDashed);
                }

                const material = materials?.mesh ?? this.materials.mesh();
                const faces = new build.FaceGroupBuilder();
                for (const grid of item.faces) {
                    faces.add(grid, id, material);
                }
                solid.add(edges, faces, distance);
                break;
            }
            default: throw new Error("type not yet supported");
        }
    }

    private removeTopologyItems(parent: visual.Item) {
        const { topologyModel } = this;
        if (parent instanceof visual.Solid) {
            for (const face of parent.allFaces) topologyModel.delete(face.simpleName);
            for (const edge of parent.allFaces) topologyModel.delete(edge.simpleName);
        }
    }

    lookupControlPointById(id: string): ControlPointData {
        const result = this.controlPointModel.get(id);
        if (result === undefined) throw new Error(`invalid precondition: object ${id} missing from control point model`);
        return result;
    }

    private removeControlPoints(parent: visual.Item) {
        parent.traverse(o => {
            if (o instanceof visual.ControlPointGroup) {
                for (const p of o) this.controlPointModel.delete(p.simpleName);
            }
        })
    }

    isHidden(item: visual.Item): boolean { return this.nodes.isHidden(item) }
    makeHidden(item: visual.Item, value: boolean): Promise<void> { return this.nodes.makeHidden(item, value) }
    unhideAll(): Promise<visual.Item[]> { return this.nodes.unhideAll() }
    isVisible(item: visual.Item): boolean { return this.nodes.isVisible(item) }
    makeVisible(item: visual.Item, value: boolean): Promise<void> { return this.nodes.makeVisible(item, value) }
    isSelectable(item: visual.Item): boolean { return this.nodes.isSelectable(item) }
    makeSelectable(item: visual.Item, value: boolean): void { return this.nodes.makeSelectable(item, value) }
    setMaterial(item: visual.Item, id: number): void { return this.nodes.setMaterial(item, id) }
    getMaterial(item: visual.Item): THREE.Material | undefined { return this.nodes.getMaterial(item) }

    lookupName(version: c3d.SimpleName) {
        return this.version2name.get(version);
    }

    lookupByName(name: c3d.SimpleName) {
        return this.lookupItemById(this.name2version.get(name)!);
    }

    pool(solid: c3d.Solid, size: number): SolidCopierPool {
        return this.copier.pool(solid, size);
    }

    saveToMemento(): GeometryMemento {
        return new GeometryMemento(
            new Map(this.geometryModel),
            new Map(this.version2name),
            new Map(this.name2version),
            new Map(this.topologyModel),
            new Map(this.controlPointModel),
            new Set(this.automatics));
    }

    restoreFromMemento(m: GeometryMemento) {
        (this.geometryModel as GeometryDatabase['geometryModel']) = new Map(m.geometryModel);
        (this.version2name as GeometryDatabase['version2name']) = new Map(m.version2name);
        (this.name2version as GeometryDatabase['name2version']) = new Map(m.name2version);
        (this.topologyModel as GeometryDatabase['topologyModel']) = new Map(m.topologyModel);
        (this.controlPointModel as GeometryDatabase['controlPointModel']) = new Map(m.controlPointModel);
        (this.automatics as GeometryDatabase['automatics']) = new Set(m.automatics);
    }

    async serialize(): Promise<Buffer> {
        return this.saveToMemento().serialize();
    }

    async deserialize(data: Buffer): Promise<visual.Item[]> {
        const everything = await c3d.Writer.ReadItems_async(data);
        return this.load(everything);
    }

    async load(model: c3d.Model, preserveNames = false): Promise<visual.Item[]> {
        const promises: Promise<visual.Item>[] = [];
        const loadItems = (stack: c3d.Item[]) => {
            while (stack.length > 0) {
                const item = stack.shift()!;
                const cast = item.Cast<c3d.Item>(item.IsA());
                if (cast instanceof c3d.Assembly) {
                    stack.push(...cast.GetItems());
                } else if (cast instanceof c3d.Instance) {
                    stack.push(cast.GetItem()!);
                } else {
                    const name = preserveNames ? item.GetItemName() : undefined;
                    promises.push(this.addItem(cast, 'user', name));
                }
            }
        }

        loadItems(model.GetItems());
        return Promise.all(promises);
    }

    validate() {
        console.assert(this.name2version.size === this.version2name.size, "maps should have same size", this.name2version, this.version2name);
    }

    debug() {
        console.group("GeometryDatabase");
        console.info("Version: ", this.version);
        const { geometryModel, topologyModel, controlPointModel, name2version, version2name } = this;
        console.group("geometryModel");
        console.table([...geometryModel].map(([name]) => { return { name } }));
        console.groupEnd();
        console.group("topologyModel");
        console.table([...topologyModel].map(([name]) => { return { name } }));
        console.groupEnd();
        console.group("controlPointModel");
        console.table([...controlPointModel].map(([name, stack]) => { return { name } }));
        console.groupEnd();
        console.group("name2version");
        console.table([...name2version].map(([name, version]) => { return { name, version } }));
        console.groupEnd();
        console.group("version2name");
        console.table([...version2name].map(([version, name]) => { return { version, name } }));
        console.groupEnd();
        console.groupEnd();
    }
}

export type Replacement = { from: visual.Item, to: visual.Item }
