/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */



import { PathLike } from "fs";
import * as Path from "path";
import * as FsPromises from "fs/promises";
import { ChildProcess } from "child_process";

export namespace ListUtils {
    /**
     * Merge two or more lists. This function will return a list of unique
     * items. Duplicates are removed.
     *
     * @param list Array list containing lists of workbenches
     */
    export function mergeUnique<T>(getKey: (o: T) => string, ...lists: Array<T>[]): T[] {
        const result: Map<string, T> = new Map<string, T>();

        lists.forEach(list => {
            list.forEach(item => {
                result.set(getKey(item), item);
            });
        });

        return Array.from(result.values());
    }
}

export namespace LanguageUtils {
    const cExtensions = [".c", ".h"];
    const cppExtensions = [".cpp", ".hpp", ".cxx", ".hxx", ".cc", ".hh"];


    export type Language = "c" | "cpp";

    export function determineLanguage(filePath: PathLike): Language | undefined {
        const extension = Path.extname(filePath.toString());

        if (cExtensions.includes(extension)) {
            return "c";
        } else if (cppExtensions.includes(extension)) {
            return "cpp";
        } else {
            return undefined;
        }
    }
}

export namespace ProcessUtils {
    /**
     * Waits for a process to exit. Returns the exit code of the process.
     */
    export function waitForExitCode(process: ChildProcess): Promise<number | null> {
        return new Promise((resolve, reject) => {
            process.on("exit", code => {
                resolve(code);
            });
            process.on("error", e => reject(e));
        });
    }
    /**
     * Waits for a process to exit. Rejects if the exit code is non-zero.
     */
    export async function waitForExit(process: ChildProcess): Promise<void> {
        const code = await waitForExitCode(process);
        if (code !== 0) {
            throw new Error("Process exited with code: " + code);
        }
    }
}

export namespace BackupUtils {
    export function isBackupFile(project: string): boolean {
        return /^Backup\s+(\(\d+\)\s+)?of.*\.ewp$/.test(Path.basename(project)) ||
            /^.*\s+のバックアップ(\s+\(\d+\))?\.ewp$/.test(Path.basename(project));
    }
    /**
     * Performs a task that might erroneously produce a backup of a project file and returns the result of the task.
     * Any backups created while performing the tasks are automatically removed.
     * See IDE-5888: simply loading a project would create a backup identical to the original file. See also VSC-192.
     * @param project The path to the project that the task uses, i.e. the project to watch for backups of
     * @param task Some task that might produce backup files. After fulfilling, any backup files are removed
     * @returns The result of #{@link task}
     */
    export async function doWithBackupCheck<T>(project: string, task: () => Promise<T>): Promise<T> {
        // TODO: only do this if we detect from the platform version that it is needed
        const projectDir = Path.dirname(project);
        const projectNameRegex = RegexUtils.escape(Path.basename(project, ".ewp"));
        // match all backup files for the project (.ewp, .ewt, .ewd)
        const backupRegexEng = new RegExp(`Backup\\s+(\\(\\d+\\))?\\s*of ${projectNameRegex}\\.ew`);
        const backupRegexJpn = new RegExp(`${projectNameRegex}\\s+のバックアップ(\\s+\\(\\d+\\))?\\.ew`);
        const originalBackupFiles = (await FsPromises.readdir(projectDir)).
            filter(file => file.match(backupRegexEng) || file.match(backupRegexJpn));

        const taskPromise = task();
        taskPromise.finally(async() => {
            const backupFilesAfterExit = (await FsPromises.readdir(Path.dirname(project))).
                filter(file => file.match(backupRegexEng) || file.match(backupRegexJpn));
            if (originalBackupFiles.length !== backupFilesAfterExit.length) {
                const newBackupFiles = backupFilesAfterExit.filter(backupFile => !originalBackupFiles.includes(backupFile));
                await Promise.allSettled(newBackupFiles.map(file => FsPromises.rm(Path.join(projectDir, file))));
            }
        });

        return taskPromise;
    }
}

export namespace RegexUtils {
    /**
     * Escapes a string for use in a regular expression.
     * The returned string will be a regex matching the input string exactly.
     */
    export function escape(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
}