/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as path from 'path';
import { createWriteStream, WriteStream } from 'fs';
import { Readable } from 'stream';
import { nfcall, ninvoke, SimpleThrottler } from 'vs/base/common/async';
import { mkdirp, rimraf } from 'vs/base/node/pfs';
import { TPromise } from 'vs/base/common/winjs.base';
import { open as _openZip, Entry, ZipFile } from 'yauzl';

export interface IExtractOptions {
	overwrite?: boolean;

	/**
	 * Source path within the ZIP archive. Only the files contained in this
	 * path will be extracted.
	 */
	sourcePath?: string;
}

interface IOptions {
	sourcePathRegex: RegExp;
}

export enum ExtractErrorType {
	Undefined,
	CorruptZip
}

export class ExtractError extends Error {

	readonly type: ExtractErrorType;
	readonly cause: Error;

	constructor(type: ExtractErrorType, cause: Error) {
		let message = cause.message;

		switch (type) {
			case ExtractErrorType.CorruptZip: message = `Corrupt ZIP: ${message}`; break;
		}

		super(message);
		this.type = type;
		this.cause = cause;
	}
}

function modeFromEntry(entry: Entry) {
	let attr = entry.externalFileAttributes >> 16 || 33188;

	return [448 /* S_IRWXU */, 56 /* S_IRWXG */, 7 /* S_IRWXO */]
		.map(mask => attr & mask)
		.reduce((a, b) => a + b, attr & 61440 /* S_IFMT */);
}

function toExtractError(err: Error): ExtractError {
	let type = ExtractErrorType.CorruptZip;

	if (/end of central directory record signature not found/.test(err.message)) {
		type = ExtractErrorType.CorruptZip;
	}

	return new ExtractError(type, err);
}

function extractEntry(stream: Readable, fileName: string, mode: number, targetPath: string, options: IOptions): TPromise<void> {
	const dirName = path.dirname(fileName);
	const targetDirName = path.join(targetPath, dirName);
	const targetFileName = path.join(targetPath, fileName);

	let istream: WriteStream;
	return mkdirp(targetDirName).then(() => new TPromise((c, e) => {
		istream = createWriteStream(targetFileName, { mode });
		istream.once('close', () => c(null));
		istream.once('error', e);
		stream.once('error', e);
		stream.pipe(istream);
	}, () => {
		if (istream) {
			istream.close();
		}
	}));
}

function extractZip(zipfile: ZipFile, targetPath: string, options: IOptions): TPromise<void> {
	let isCanceled = false;
	let last = TPromise.wrap<any>(null);

	return new TPromise((c, e) => {
		const throttler = new SimpleThrottler();

		zipfile.once('error', e);
		zipfile.once('close', () => last.then(c, e));
		zipfile.on('entry', (entry: Entry) => {
			if (isCanceled) {
				return;
			}

			if (!options.sourcePathRegex.test(entry.fileName)) {
				return;
			}

			const fileName = entry.fileName.replace(options.sourcePathRegex, '');

			// directory file names end with '/'
			if (/\/$/.test(fileName)) {
				const targetFileName = path.join(targetPath, fileName);
				last = mkdirp(targetFileName);
				return;
			}

			const stream = ninvoke(zipfile, zipfile.openReadStream, entry);
			const mode = modeFromEntry(entry);

			last = throttler.queue(() => stream.then(stream => extractEntry(stream, fileName, mode, targetPath, options)));
		});
	}, () => {
		isCanceled = true;
		last.cancel();
		zipfile.close();
	}).then(null, err => TPromise.wrapError(toExtractError(err)));
}

function openZip(zipFile: string): TPromise<ZipFile> {
	return nfcall<ZipFile>(_openZip, zipFile)
		.then(null, err => TPromise.wrapError(toExtractError(err)));
}

export function extract(zipPath: string, targetPath: string, options: IExtractOptions = {}): TPromise<void> {
	const sourcePathRegex = new RegExp(options.sourcePath ? `^${options.sourcePath}` : '');

	let promise = openZip(zipPath);

	if (options.overwrite) {
		promise = promise.then(zipfile => rimraf(targetPath).then(() => zipfile));
	}

	return promise.then(zipfile => extractZip(zipfile, targetPath, { sourcePathRegex }));
}

function read(zipPath: string, filePath: string): TPromise<Readable> {
	return openZip(zipPath).then(zipfile => {
		return new TPromise<Readable>((c, e) => {
			zipfile.on('entry', (entry: Entry) => {
				if (entry.fileName === filePath) {
					ninvoke<Readable>(zipfile, zipfile.openReadStream, entry).done(stream => c(stream), err => e(err));
				}
			});

			zipfile.once('close', () => e(new Error(nls.localize('notFound', "{0} not found inside zip.", filePath))));
		});
	});
}

export function buffer(zipPath: string, filePath: string): TPromise<Buffer> {
	return read(zipPath, filePath).then(stream => {
		return new TPromise<Buffer>((c, e) => {
			const buffers: Buffer[] = [];
			stream.once('error', e);
			stream.on('data', b => buffers.push(b as Buffer));
			stream.on('end', () => c(Buffer.concat(buffers)));
		});
	});
}
