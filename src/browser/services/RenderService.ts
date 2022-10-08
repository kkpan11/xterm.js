/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IRenderer, IRenderDimensions } from 'browser/renderer/shared/Types';
import { RenderDebouncer } from 'browser/RenderDebouncer';
import { EventEmitter, IEvent } from 'common/EventEmitter';
import { Disposable } from 'common/Lifecycle';
import { ScreenDprMonitor } from 'browser/ScreenDprMonitor';
import { addDisposableDomListener } from 'browser/Lifecycle';
import { IColorSet, IRenderDebouncerWithCallback } from 'browser/Types';
import { IOptionsService, IBufferService, IDecorationService } from 'common/services/Services';
import { ICharSizeService, ICoreBrowserService, IRenderService } from 'browser/services/Services';
import { DebouncedIdleTask } from 'common/TaskQueue';

interface ISelectionState {
  start: [number, number] | undefined;
  end: [number, number] | undefined;
  columnSelectMode: boolean;
}

export class RenderService extends Disposable implements IRenderService {
  public serviceBrand: undefined;

  private _renderer: IRenderer | undefined;
  private _renderDebouncer: IRenderDebouncerWithCallback;
  private _screenDprMonitor: ScreenDprMonitor;
  private _pausedResizeTask = new DebouncedIdleTask();

  private _isPaused: boolean = false;
  private _needsFullRefresh: boolean = false;
  private _isNextRenderRedrawOnly: boolean = true;
  private _needsSelectionRefresh: boolean = false;
  private _canvasWidth: number = 0;
  private _canvasHeight: number = 0;
  private _selectionState: ISelectionState = {
    start: undefined,
    end: undefined,
    columnSelectMode: false
  };

  private readonly _onDimensionsChange = this.register(new EventEmitter<IRenderDimensions>());
  public readonly onDimensionsChange =  this._onDimensionsChange.event;
  private readonly _onRenderedViewportChange = this.register(new EventEmitter<{ start: number, end: number }>());
  public readonly onRenderedViewportChange = this._onRenderedViewportChange.event;
  private readonly _onRender = this.register(new EventEmitter<{ start: number, end: number }>());
  public readonly onRender = this._onRender.event;
  private readonly _onRefreshRequest = this.register(new EventEmitter<{ start: number, end: number }>());
  public readonly onRefreshRequest = this._onRefreshRequest.event;

  public get dimensions(): IRenderDimensions { return this._renderer!.dimensions; }

  constructor(
    private _rowCount: number,
    screenElement: HTMLElement,
    @IOptionsService optionsService: IOptionsService,
    @ICharSizeService private readonly _charSizeService: ICharSizeService,
    @IDecorationService decorationService: IDecorationService,
    @IBufferService bufferService: IBufferService,
    @ICoreBrowserService coreBrowserService: ICoreBrowserService
  ) {
    super();

    this.register({ dispose: () => this._renderer?.dispose() });

    this._renderDebouncer = new RenderDebouncer(coreBrowserService.window, (start, end) => this._renderRows(start, end));
    this.register(this._renderDebouncer);

    this._screenDprMonitor = new ScreenDprMonitor(coreBrowserService.window);
    this._screenDprMonitor.setListener(() => this.handleDevicePixelRatioChange());
    this.register(this._screenDprMonitor);

    this.register(bufferService.onResize(() => this._fullRefresh()));
    this.register(bufferService.buffers.onBufferActivate(() => this._renderer?.clear()));
    this.register(optionsService.onOptionChange(() => this._handleOptionsChanged()));
    this.register(this._charSizeService.onCharSizeChange(() => this.handleCharSizeChanged()));

    // Do a full refresh whenever any decoration is added or removed. This may not actually result
    // in changes but since decorations should be used sparingly or added/removed all in the same
    // frame this should have minimal performance impact.
    this.register(decorationService.onDecorationRegistered(() => this._fullRefresh()));
    this.register(decorationService.onDecorationRemoved(() => this._fullRefresh()));

    // No need to register this as renderer is explicitly disposed in RenderService.dispose
    // this._renderer.onRequestRedraw(e => this.refreshRows(e.start, e.end, true));

    // dprchange should handle this case, we need this as well for browsers that don't support the
    // matchMedia query.
    this.register(addDisposableDomListener(coreBrowserService.window, 'resize', () => this.handleDevicePixelRatioChange()));

    // Detect whether IntersectionObserver is detected and enable renderer pause
    // and resume based on terminal visibility if so
    if ('IntersectionObserver' in coreBrowserService.window) {
      const observer = new coreBrowserService.window.IntersectionObserver(e => this._handleIntersectionChange(e[e.length - 1]), { threshold: 0 });
      observer.observe(screenElement);
      this.register({ dispose: () => observer.disconnect() });
    }
  }

  private _handleIntersectionChange(entry: IntersectionObserverEntry): void {
    this._isPaused = entry.isIntersecting === undefined ? (entry.intersectionRatio === 0) : !entry.isIntersecting;

    // Terminal was hidden on open
    if (!this._isPaused && !this._charSizeService.hasValidSize) {
      this._charSizeService.measure();
    }

    if (!this._isPaused && this._needsFullRefresh) {
      this._pausedResizeTask.flush();
      this.refreshRows(0, this._rowCount - 1);
      this._needsFullRefresh = false;
    }
  }

  public refreshRows(start: number, end: number, isRedrawOnly: boolean = false): void {
    if (this._isPaused) {
      this._needsFullRefresh = true;
      return;
    }
    if (!isRedrawOnly) {
      this._isNextRenderRedrawOnly = false;
    }
    this._renderDebouncer.refresh(start, end, this._rowCount);
  }

  private _renderRows(start: number, end: number): void {
    if (!this._renderer) {
      return;
    }
    this._renderer.renderRows(start, end);

    // Update selection if needed
    if (this._needsSelectionRefresh) {
      this._renderer.handleSelectionChanged(this._selectionState.start, this._selectionState.end, this._selectionState.columnSelectMode);
      this._needsSelectionRefresh = false;
    }

    // Fire render event only if it was not a redraw
    if (!this._isNextRenderRedrawOnly) {
      this._onRenderedViewportChange.fire({ start, end });
    }
    this._onRender.fire({ start, end });
    this._isNextRenderRedrawOnly = true;
  }

  public resize(cols: number, rows: number): void {
    this._rowCount = rows;
    this._fireOnCanvasResize();
  }

  private _handleOptionsChanged(): void {
    if (!this._renderer) {
      return;
    }
    this._renderer.handleOptionsChanged();
    this.refreshRows(0, this._rowCount - 1);
    this._fireOnCanvasResize();
  }

  private _fireOnCanvasResize(): void {
    if (!this._renderer) {
      return;
    }
    // Don't fire the event if the dimensions haven't changed
    if (this._renderer.dimensions.canvasWidth === this._canvasWidth && this._renderer.dimensions.canvasHeight === this._canvasHeight) {
      return;
    }
    this._onDimensionsChange.fire(this._renderer.dimensions);
  }

  public hasRenderer(): boolean {
    return !!this._renderer;
  }

  public setRenderer(renderer: IRenderer): void {
    // TODO: RenderService should be the only one to dispose the renderer
    this._renderer?.dispose();
    this._renderer = renderer;
    this._renderer.onRequestRedraw(e => this.refreshRows(e.start, e.end, true));

    // Force a refresh
    this._needsSelectionRefresh = true;
    this._fullRefresh();
  }

  public addRefreshCallback(callback: FrameRequestCallback): number {
    return this._renderDebouncer.addRefreshCallback(callback);
  }

  private _fullRefresh(): void {
    if (this._isPaused) {
      this._needsFullRefresh = true;
    } else {
      this.refreshRows(0, this._rowCount - 1);
    }
  }

  public clearTextureAtlas(): void {
    if (!this._renderer) {
      return;
    }
    this._renderer.clearTextureAtlas?.();
    this._fullRefresh();
  }

  public setColors(colors: IColorSet): void {
    if (!this._renderer) {
      return;
    }
    this._renderer.setColors(colors);
    this._fullRefresh();
  }

  public handleDevicePixelRatioChange(): void {
    // Force char size measurement as DomMeasureStrategy(getBoundingClientRect) is not stable
    // when devicePixelRatio changes
    this._charSizeService.measure();

    if (!this._renderer) {
      return;
    }
    this._renderer.handleDevicePixelRatioChange();
    this.refreshRows(0, this._rowCount - 1);
  }

  public handleResize(cols: number, rows: number): void {
    if (!this._renderer) {
      return;
    }
    if (this._isPaused) {
      this._pausedResizeTask.set(() => this._renderer!.handleResize(cols, rows));
    } else {
      this._renderer.handleResize(cols, rows);
    }
    this._fullRefresh();
  }

  // TODO: Is this useful when we have onResize?
  public handleCharSizeChanged(): void {
    this._renderer?.handleCharSizeChanged();
  }

  public handleBlur(): void {
    this._renderer?.handleBlur();
  }

  public handleFocus(): void {
    this._renderer?.handleFocus();
  }

  public handleSelectionChanged(start: [number, number] | undefined, end: [number, number] | undefined, columnSelectMode: boolean): void {
    this._selectionState.start = start;
    this._selectionState.end = end;
    this._selectionState.columnSelectMode = columnSelectMode;
    this._renderer?.handleSelectionChanged(start, end, columnSelectMode);
  }

  public handleCursorMove(): void {
    this._renderer?.handleCursorMove();
  }

  public clear(): void {
    this._renderer?.clear();
  }
}
