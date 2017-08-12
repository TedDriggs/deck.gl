// Copyright (c) 2015 - 2017 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// TODO - replace with math.gl
import log from '../utils/log';

import {equals} from '../math/equals';
import mat4_scale from 'gl-mat4/scale';
import mat4_translate from 'gl-mat4/translate';
import mat4_multiply from 'gl-mat4/multiply';
import mat4_invert from 'gl-mat4/invert';
import vec2_lerp from 'gl-vec2/lerp';

import mat4_perspective from 'gl-mat4/perspective';
import mat4_ortho from 'gl-mat4/ortho';

import {transformVector, createMat4, extractCameraVectors} from '../math/utils';

import {
  projectFlat,
  // unprojectFlat,
  calculateDistanceScales
  // makeProjectionMatrixFromMercatorParams,
  // makeUncenteredViewMatrixFromMercatorParams
} from '../viewport-mercator-project/web-mercator-utils';

import assert from 'assert';

const DEGREES_TO_RADIANS = Math.PI / 180;

const IDENTITY = createMat4();

const DEFAULT_DISTANCE_SCALES = {
  pixelsPerMeter: [1, 1, 1],
  metersPerPixel: [1, 1, 1],
  pixelsPerDegree: [1, 1, 1],
  degreesPerPixel: [1, 1, 1]
};

const ERR_ARGUMENT = 'Illegal argument to Viewport';

export default class Viewport {
  /**
   * @classdesc
   * Manages coordinate system transformations for deck.gl.
   *
   * Note: The Viewport is immutable in the sense that it only has accessors.
   * A new viewport instance should be created if any parameters have changed.
   */
  constructor(opts = {}) {
    const {
      // Window width/height in pixels (for pixel projection)
      width = 1,
      height = 1,

      // view matrix
      viewMatrix = IDENTITY,

      projectionMatrix = IDENTITY, // Projection matrix: option 1
      // Projection matrix: option 2, perspective
      fovy = 75,
      aspect = null,
      // projection matrix: option 3, orthographic
      left, // Left bound of the frustum
      top, // Top bound of the frustum
      right = null, // Right bound of the frustum (automatically calculated)
      bottom = null, // Bottom bound of the frustum (automatically calculated)
      // Projection matrix clipping planes
      near = 1, // Distance of near clipping plane
      far = 100, // Distance of far clipping plane

      // Optional: A lnglat anchor will make this viewport work with geospatial coordinate systems
      longitude = null,
      latitude = null,
      zoom = null,

      distanceScales = null
    } = opts;

    // Silently allow apps to send in 0,0
    this.width = width || 1;
    this.height = height || 1;
    this.scale = Number.isFinite(zoom) ? Math.pow(2, zoom) : 1;

    // Calculate distance scales if lng/lat/zoom are provided
    const geospatialParamsSupplied = !isNaN(latitude) || !isNaN(longitude) || !isNaN(zoom);
    if (geospatialParamsSupplied) {
      this.distanceScales = calculateDistanceScales({latitude, longitude, scale: this.scale});
    } else {
      this.distanceScales = distanceScales || DEFAULT_DISTANCE_SCALES;
    }

    this.viewMatrixUncentered = viewMatrix;

    // Make a centered version of the matrix for projection modes without an offset
    this.center = geospatialParamsSupplied ?
      projectFlat([longitude, latitude], this.scale) :
      [0, 0, 0];

    const centerTranslation = [-this.center[0], -this.center[1], 0];
    this.viewMatrix = mat4_translate(createMat4(), this.viewMatrixUncentered, centerTranslation);

    this.projectionMatrix = this._createProjectionMatrix({
      width: this.width,
      height: this.height,
      projectionMatrix,
      fovy, aspect, // perspective matrix opts
      left, top, right, bottom, // orthographic matrix opts, bounds of the frustum
      near, far // Distance of near/far clipping plane
    });

    // Init pixel matrices
    this._initMatrices();

    // Bind methods for easy access
    this.equals = this.equals.bind(this);
    this.project = this.project.bind(this);
    this.unproject = this.unproject.bind(this);
    this.projectFlat = this.projectFlat.bind(this);
    this.unprojectFlat = this.unprojectFlat.bind(this);
    this.getMatrices = this.getMatrices.bind(this);
  }

  // Two viewports are equal if width and height are identical, and if
  // their view and projection matrices are (approximately) equal.
  equals(viewport) {
    if (!(viewport instanceof Viewport)) {
      return false;
    }

    return viewport.width === this.width &&
      viewport.height === this.height &&
      equals(viewport.projectionMatrix, this.projectionMatrix) &&
      equals(viewport.viewMatrix, this.viewMatrix);
      // TODO - check distance scales?
  }

  /**
   * Projects xyz (possibly latitude and longitude) to pixel coordinates in window
   * using viewport projection parameters
   * - [longitude, latitude] to [x, y]
   * - [longitude, latitude, Z] => [x, y, z]
   * Note: By default, returns top-left coordinates for canvas/SVG type render
   *
   * @param {Array} lngLatZ - [lng, lat] or [lng, lat, Z]
   * @param {Object} opts - options
   * @param {Object} opts.topLeft=true - Whether projected coords are top left
   * @return {Array} - [x, y] or [x, y, z] in top left coords
   */
  project(xyz, {topLeft = false} = {}) {
    const [x0, y0, z0 = 0] = xyz;
    assert(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(z0), ERR_ARGUMENT);

    const [X, Y] = this.projectFlat([x0, y0]);
    const v = transformVector(this.pixelProjectionMatrix, [X, Y, z0, 1]);

    const [x, y] = v;
    const y2 = topLeft ? this.height - y : y;
    return xyz.length === 2 ? [x, y2] : [x, y2, 0];
  }

  /**
   * Unproject pixel coordinates on screen onto world coordinates,
   * (possibly [lon, lat]) on map.
   * - [x, y] => [lng, lat]
   * - [x, y, z] => [lng, lat, Z]
   * @param {Array} xyz -
   * @return {Array} - [lng, lat, Z] or [X, Y, Z]
   */
  unproject(xyz, {topLeft = false} = {}) {
    const [x, y, targetZ = 0] = xyz;

    const y2 = topLeft ? this.height - y : y;

    // since we don't know the correct projected z value for the point,
    // unproject two points to get a line and then find the point on that line with z=0
    const coord0 = transformVector(this.pixelUnprojectionMatrix, [x, y2, 0, 1]);
    const coord1 = transformVector(this.pixelUnprojectionMatrix, [x, y2, 1, 1]);

    const z0 = coord0[2];
    const z1 = coord1[2];

    const t = z0 === z1 ? 0 : (targetZ - z0) / (z1 - z0);
    const v = vec2_lerp([], coord0, coord1, t);

    const vUnprojected = this.unprojectFlat(v);
    return xyz.length === 2 ? vUnprojected : [vUnprojected[0], vUnprojected[1], 0];
  }

  // NON_LINEAR PROJECTION HOOKS
  // Used for web meractor projection

  /**
   * Project [lng,lat] on sphere onto [x,y] on 512*512 Mercator Zoom 0 tile.
   * Performs the nonlinear part of the web mercator projection.
   * Remaining projection is done with 4x4 matrices which also handles
   * perspective.
   * @param {Array} lngLat - [lng, lat] coordinates
   *   Specifies a point on the sphere to project onto the map.
   * @return {Array} [x,y] coordinates.
   */
  projectFlat([x, y], scale = this.scale) {
    return this._projectFlat(...arguments);
  }

  /**
   * Unproject world point [x,y] on map onto {lat, lon} on sphere
   * @param {object|Vector} xy - object with {x,y} members
   *  representing point on projected map plane
   * @return {GeoCoordinates} - object with {lat,lon} of point on sphere.
   *   Has toArray method if you need a GeoJSON Array.
   *   Per cartographic tradition, lat and lon are specified as degrees.
   */
  unprojectFlat(xyz, scale = this.scale) {
    return this._unprojectFlat(...arguments);
  }

  // TODO - why do we need these?
  _projectFlat(xyz, scale = this.scale) {
    return xyz;
  }

  _unprojectFlat(xyz, scale = this.scale) {
    return xyz;
  }

  getMatrices({modelMatrix = null} = {}) {
    let modelViewProjectionMatrix = this.viewProjectionMatrix;
    let pixelProjectionMatrix = this.pixelProjectionMatrix;
    let pixelUnprojectionMatrix = this.pixelUnprojectionMatrix;

    if (modelMatrix) {
      modelViewProjectionMatrix = mat4_multiply([], this.viewProjectionMatrix, modelMatrix);
      pixelProjectionMatrix = mat4_multiply([], this.pixelProjectionMatrix, modelMatrix);
      pixelUnprojectionMatrix = mat4_invert([], pixelProjectionMatrix);
    }

    const matrices = Object.assign({
      modelViewProjectionMatrix,
      viewProjectionMatrix: this.viewProjectionMatrix,
      viewMatrix: this.viewMatrix,
      projectionMatrix: this.projectionMatrix,

      // project/unproject between pixels and world
      pixelProjectionMatrix,
      pixelUnprojectionMatrix,

      width: this.width,
      height: this.height,
      scale: this.scale
    });

    return matrices;
  }

  getDistanceScales() {
    return this.distanceScales;
  }

  getCameraPosition() {
    return this.cameraPosition;
  }

  getCameraDirection() {
    return this.cameraDirection;
  }

  getCameraUp() {
    return this.cameraUp;
  }

  // INTERNAL METHODS

  _initMatrices() {
    // Note: As usual, matrix operations should be applied in "reverse" order
    // since vectors will be multiplied in from the right during transformation
    const vpm = createMat4();
    mat4_multiply(vpm, vpm, this.projectionMatrix);
    mat4_multiply(vpm, vpm, this.viewMatrix);
    this.viewProjectionMatrix = vpm;

    // Calculate inverse view matrix
    this.viewMatrixInverse = mat4_invert([], this.viewMatrix) || this.viewMatrix;

    // Decompose camera directions
    const {eye, direction, up} = extractCameraVectors({
      viewMatrix: this.viewMatrix,
      viewMatrixInverse: this.viewMatrixInverse
    });
    this.cameraPosition = eye;
    this.cameraDirection = direction;
    this.cameraUp = up;

    /*
     * Builds matrices that converts preprojected lngLats to screen pixels
     * and vice versa.
     * Note: Currently returns bottom-left coordinates!
     * Note: Starts with the GL projection matrix and adds steps to the
     *       scale and translate that matrix onto the window.
     * Note: WebGL controls clip space to screen projection with gl.viewport
     *       and does not need this step.
     */

    // matrix for conversion from location to screen coordinates
    const m = createMat4();
    mat4_scale(m, m, [this.width / 2, -this.height / 2, 1]);
    mat4_translate(m, m, [1, -1, 0]);
    mat4_multiply(m, m, this.viewProjectionMatrix);
    this.pixelProjectionMatrix = m;

    this.pixelUnprojectionMatrix = mat4_invert(createMat4(), this.pixelProjectionMatrix);
    if (!this.pixelUnprojectionMatrix) {
      log.warn('Pixel project matrix not invertible');
      throw new Error('Pixel project matrix not invertible');
    }
  }

  // Extracts or creates projection matrix from supplied options
  // Optionally creates a perspective or orthographic matrix
  _createProjectionMatrix({ // viewport arguments
    width, // Width of viewport
    height, // Height of viewport

    // Projection matrix: option 1
    projectionMatrix = null,
    // Projection matrix: option 2, perspective
    fovy = 75, // Field of view covered by camera
    aspect = null,
    // projection matrix: option 3, orthographic
    left, // Left bound of the frustum
    top, // Top bound of the frustum
    right = null, // Right bound of the frustum (automatically calculated)
    bottom = null, // Bottom bound of the frustum (automatically calculated)
    // Projection matrix clipping planes
    near = 1, // Distance of near clipping plane
    far = 100 // Distance of far clipping plane
  }) {
    // If left and top are supplied, create an ortographic projection matrix
    if (!projectionMatrix && Number.isFinite(left) && Number.isFinite(top)) {
      right = Number.isFinite(right) ? right : left + width;
      bottom = Number.isFinite(bottom) ? bottom : top + height;
      projectionMatrix = mat4_ortho([], left, right, bottom, top, near, far);
    }

    // If fovy is provided, create a perspective projection matrix
    if (!projectionMatrix && Number.isFinite(fovy)) {
      const fovyRadians = fovy * DEGREES_TO_RADIANS;
      aspect = Number.isFinite(aspect) ? aspect : width / height;
      return mat4_perspective([], fovyRadians, aspect, near, far);
    }

    assert(projectionMatrix);

    return projectionMatrix;
  }
}