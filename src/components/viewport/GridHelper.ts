import * as THREE from 'three';
import * as visual from "../../visual_model/VisualModel";

export class GridHelper extends THREE.GridHelper {
    constructor(size?: number, divisions?: number, color1?: THREE.Color | string | number, color2?: THREE.Color | string | number) {
        super(size, divisions, color1, color2);
        this.geometry.rotateX(Math.PI / 2);
        const material = this.material as THREE.LineBasicMaterial;
        material.transparent = true;
        this.renderOrder = -2;
        this.layers.set(visual.Layers.Overlay);
        material.fog = true;
    }

    private readonly grid = new THREE.Vector3(0, 1, 0);
    private readonly eye = new THREE.Vector3(0, 0, 1);
    update(camera: THREE.Camera) {
        const { grid, eye } = this;

        grid.set(0, 0, 1).applyQuaternion(this.quaternion);
        eye.set(0, 0, 1).applyQuaternion(camera.quaternion);
        const dot = grid.dot(eye);
        const material = this.material as THREE.LineBasicMaterial;
        material.opacity = dot * dot;
        this.updateMatrixWorld();
    }
}