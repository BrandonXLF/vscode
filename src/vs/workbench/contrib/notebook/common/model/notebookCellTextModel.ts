/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { ICell, NotebookCellOutputsSplice, CellKind, NotebookCellMetadata, NotebookDocumentMetadata, TransientOptions, IOutputDto, ICellOutput } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { PieceTreeTextBufferBuilder } from 'vs/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder';
import { URI } from 'vs/base/common/uri';
import * as UUID from 'vs/base/common/uuid';
import * as model from 'vs/editor/common/model';
import { Range } from 'vs/editor/common/core/range';
import { Disposable } from 'vs/base/common/lifecycle';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { hash } from 'vs/base/common/hash';
import { PieceTreeTextBuffer } from 'vs/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBuffer';
import { NotebookCellOutputTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookCellOutputTextModel';

export class NotebookCellTextModel extends Disposable implements ICell {
	private _onDidChangeOutputs = new Emitter<NotebookCellOutputsSplice[]>();
	onDidChangeOutputs: Event<NotebookCellOutputsSplice[]> = this._onDidChangeOutputs.event;

	private _onDidChangeContent = new Emitter<void>();
	onDidChangeContent: Event<void> = this._onDidChangeContent.event;

	private _onDidChangeMetadata = new Emitter<void>();
	onDidChangeMetadata: Event<void> = this._onDidChangeMetadata.event;

	private _onDidChangeLanguage = new Emitter<string>();
	onDidChangeLanguage: Event<string> = this._onDidChangeLanguage.event;

	private _outputs: NotebookCellOutputTextModel[];

	get outputs(): ICellOutput[] {
		return this._outputs;
	}

	private _metadata: NotebookCellMetadata;

	get metadata() {
		return this._metadata;
	}

	set metadata(newMetadata: NotebookCellMetadata) {
		this._metadata = newMetadata;
		this._hash = null;
		this._onDidChangeMetadata.fire();
	}

	get language() {
		return this._language;
	}

	set language(newLanguage: string) {
		this._language = newLanguage;
		this._hash = null;
		this._onDidChangeLanguage.fire(newLanguage);
	}

	private _textBuffer!: model.IReadonlyTextBuffer;

	get textBuffer() {
		if (this._textBuffer) {
			return this._textBuffer;
		}

		const builder = new PieceTreeTextBufferBuilder();
		builder.acceptChunk(this._source);
		const bufferFactory = builder.finish();
		const { textBuffer, disposable } = bufferFactory.create(model.DefaultEndOfLine.LF, true);
		this._textBuffer = textBuffer;
		this._register(disposable);

		this._register(this._textBuffer.onDidChangeContent(() => {
			this._hash = null;
			this._onDidChangeContent.fire();
		}));

		return this._textBuffer;
	}

	private _hash: number | null = null;


	constructor(
		readonly uri: URI,
		public handle: number,
		private _source: string,
		private _language: string,
		public cellKind: CellKind,
		outputs: IOutputDto[],
		metadata: NotebookCellMetadata | undefined,
		public readonly transientOptions: TransientOptions,
		private readonly _modelService: ITextModelService
	) {
		super();
		this._outputs = outputs.map(op => new NotebookCellOutputTextModel(op));
		this._metadata = metadata || {};
	}

	getValue(): string {
		const fullRange = this.getFullModelRange();
		const eol = this.textBuffer.getEOL();
		if (eol === '\n') {
			return this.textBuffer.getValueInRange(fullRange, model.EndOfLinePreference.LF);
		} else {
			return this.textBuffer.getValueInRange(fullRange, model.EndOfLinePreference.CRLF);
		}
	}

	getHashValue(): number {
		if (this._hash !== null) {
			return this._hash;
		}

		// TODO@rebornix, raw outputs
		this._hash = hash([hash(this.language), hash(this.getValue()), this._getPersisentMetadata, this.transientOptions.transientOutputs ? [] : this._outputs]);
		return this._hash;
	}

	private _getPersisentMetadata() {
		let filteredMetadata: { [key: string]: any } = {};
		const transientMetadata = this.transientOptions.transientMetadata;

		const keys = new Set([...Object.keys(this.metadata)]);
		for (let key of keys) {
			if (!(transientMetadata[key as keyof NotebookCellMetadata])
			) {
				filteredMetadata[key] = this.metadata[key as keyof NotebookCellMetadata];
			}
		}

		return filteredMetadata;
	}

	getTextLength(): number {
		return this.textBuffer.getLength();
	}

	getFullModelRange() {
		const lineCount = this.textBuffer.getLineCount();
		return new Range(1, 1, lineCount, this.textBuffer.getLineLength(lineCount) + 1);
	}

	spliceNotebookCellOutputs(splices: NotebookCellOutputsSplice[]): void {
		splices.reverse().forEach(splice => {
			this.outputs.splice(splice[0], splice[1], ...splice[2]);
		});

		this._onDidChangeOutputs.fire(splices);
	}

	getEvaluatedMetadata(documentMetadata: NotebookDocumentMetadata): NotebookCellMetadata {
		const editable = this.metadata?.editable ??
			documentMetadata.cellEditable;

		const hasExecutionOrder = this.metadata?.hasExecutionOrder ??
			documentMetadata.cellHasExecutionOrder;

		return {
			...(this.metadata || {}),
			...{
				editable,
				hasExecutionOrder
			}
		};
	}

	async resolveTextModelRef() {
		const ref = await this._modelService.createModelReference(this.uri);
		return ref;
	}

	dispose() {
		// Manually release reference to previous text buffer to avoid large leaks
		// in case someone leaks a CellTextModel reference
		const emptyDisposedTextBuffer = new PieceTreeTextBuffer([], '', '\n', false, false, true, true);
		emptyDisposedTextBuffer.dispose();
		this._textBuffer = emptyDisposedTextBuffer;
		super.dispose();
	}
}

export function cloneMetadata(cell: NotebookCellTextModel) {
	return {
		editable: cell.metadata?.editable,
		breakpointMargin: cell.metadata?.breakpointMargin,
		hasExecutionOrder: cell.metadata?.hasExecutionOrder,
		inputCollapsed: cell.metadata?.inputCollapsed,
		outputCollapsed: cell.metadata?.outputCollapsed,
		custom: cell.metadata?.custom
	};
}

export function cloneNotebookCellTextModel(cell: NotebookCellTextModel) {
	return {
		source: cell.getValue(),
		language: cell.language,
		cellKind: cell.cellKind,
		outputs: cell.outputs.map(output => ({
			outputs: output.outputs,
			/* paste should generate new outputId */ outputId: UUID.generateUuid()
		})),
		metadata: cloneMetadata(cell)
	};
}
