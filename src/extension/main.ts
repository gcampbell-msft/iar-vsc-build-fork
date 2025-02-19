/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as vscode from "vscode";
import { ExtensionState } from "./extensionstate";
import { IarToolManager } from "../iar/tools/manager";
import { ExtensionSettings } from "./settings/extensionsettings";
import { IarTaskProvider } from "./task/provider";
import { GetSettingsCommand } from "./command/getsettings";
import { CpptoolsIntellisenseService } from "./intellisense/cpptoolsintellisenseservice";
import { CStatTaskProvider } from "./task/cstat/cstattaskprovider";
import { TreeProjectView } from "./ui/treeprojectview";
import { ReloadProjectCommand } from "./command/project/reloadproject";
import { RemoveNodeCommand } from "./command/project/removenode";
import { AddFileCommand, AddFileToRootCommand, AddGroupCommand, AddGroupToRootCommand } from "./command/project/addnode";
import { SettingsWebview } from "./ui/settingswebview";
import { AddWorkbenchCommand } from "./command/addworkbench";
import { Command } from "./command/command";
import { BuildExtensionApi } from "iar-vsc-common/buildExtension";
import { Project } from "../iar/project/project";
import { logger } from "iar-vsc-common/logger";
import { EwpFile } from "../iar/project/parsing/ewpfile";
import { FileListWatcher } from "./filelistwatcher";
import { API } from "./api";
import { StatusBarItem } from "./ui/statusbaritem";
import { BehaviorSubject } from "rxjs";
import { ToolbarWebview } from "./ui/toolbarview";
import { ToggleCstatToolbarCommand } from "./command/togglecstattoolbar";
import { OsUtils } from "iar-vsc-common/osUtils";
import { EwWorkspace } from "../iar/workspace/ewworkspace";
import { EwwFile } from "../iar/workspace/ewwfile";
import { TreeBatchBuildView } from "./ui/batchbuildview";
import { BatchBuild } from "./ui/batchbuildcommands";

export function activate(context: vscode.ExtensionContext): BuildExtensionApi {
    logger.init("IAR Build");
    logger.debug("Activating extension");
    IarVsc.extensionContext = context;
    ExtensionState.init(IarVsc.toolManager);

    // --- create and register commands
    GetSettingsCommand.initCommands(context);
    new ReloadProjectCommand().register(context);
    new AddFileToRootCommand().register(context);
    new AddGroupToRootCommand().register(context);
    new AddFileCommand().register(context);
    new AddGroupCommand().register(context);
    new RemoveNodeCommand().register(context);
    new ToggleCstatToolbarCommand().register(context);
    const addWorkbenchCmd = new AddWorkbenchCommand(IarVsc.toolManager);
    addWorkbenchCmd.register(context);
    const workbenchCmd = Command.createSelectWorkbenchCommand(ExtensionState.getInstance().workbench);
    workbenchCmd.register(context);
    const workspaceCmd = Command.createSelectWorkspaceCommand(ExtensionState.getInstance().workspace);
    workspaceCmd.register(context);
    const projectCmd = Command.createSelectProjectCommand(ExtensionState.getInstance().project);
    projectCmd.register(context);
    const configCmd = Command.createSelectConfigurationCommand(ExtensionState.getInstance().config);
    configCmd.register(context);

    // --- initialize custom GUI
    const workbenchModel = ExtensionState.getInstance().workbench;
    const workspaceModel = ExtensionState.getInstance().workspace;
    const projectModel = ExtensionState.getInstance().project;
    const configModel = ExtensionState.getInstance().config;

    IarVsc.settingsView = new SettingsWebview(context.extensionUri, workbenchModel, workspaceModel, projectModel, configModel, addWorkbenchCmd, IarVsc.workbenchesLoading);
    vscode.window.registerWebviewViewProvider(SettingsWebview.VIEW_TYPE, IarVsc.settingsView);
    vscode.window.registerWebviewViewProvider(ToolbarWebview.VIEW_TYPE, new ToolbarWebview(context.extensionUri));
    IarVsc.projectTreeView = new TreeProjectView(
        projectModel,
        ExtensionState.getInstance().extendedProject,
        workbenchModel,
        ExtensionState.getInstance().extendedWorkbench,
        ExtensionState.getInstance().loading,
    );

    // Batch build
    IarVsc.batchbuildTreeView = new TreeBatchBuildView(
        ExtensionState.getInstance().loadedWorkspace,
        ExtensionState.getInstance().extendedWorkbench,
        ExtensionState.getInstance().loading);
    BatchBuild.Init(context);

    StatusBarItem.createFromModel("iar.workbench", workbenchModel, workbenchCmd, "IAR Toolchain: ", 5);
    StatusBarItem.createFromModel("iar.workspace", workspaceModel, workspaceCmd, "Workspace: ", 4);
    StatusBarItem.createFromModel("iar.project", projectModel, projectCmd, "Project: ", 3);
    StatusBarItem.createFromModel("iar.configuration", configModel, configCmd, "Configuration: ", 2);

    // --- register tasks
    IarTaskProvider.register();
    CStatTaskProvider.register(context);

    // --- start cpptools interface
    CpptoolsIntellisenseService.init();

    // --- find and add all .ewp projects and.custom_argvars files
    // note that we do not await here, this operation can be slow and we want activation to be quick
    setupFileWatchers(context);

    // --- find and add workbenches
    loadTools(addWorkbenchCmd);
    ExtensionSettings.observeSetting(ExtensionSettings.ExtensionSettingsField.IarInstallDirectories, () => loadTools());


    // --- provide the public typescript API
    return API;
}

export async function deactivate() {
    logger.debug("Deactivating extension");
    if (CpptoolsIntellisenseService.instance) {
        CpptoolsIntellisenseService.instance.close();
    }
    IarTaskProvider.unregister();
    CStatTaskProvider.unRegister();
    await ExtensionState.getInstance().dispose();
}

async function setupFileWatchers(context: vscode.ExtensionContext) {
    // Workspaces
    IarVsc.ewwWatcher = await FileListWatcher.initialize("**/*.eww");
    context.subscriptions.push(IarVsc.ewwWatcher);

    IarVsc.ewwWatcher.subscribe(files => {
        const workspaces: EwWorkspace[] = [];
        files.
            forEach(file => {
                try {
                    workspaces.push(new EwwFile(file));
                } catch (e) {
                    logger.error(`Could not parse workspace file '${file}': ${e}`);
                    vscode.window.showErrorMessage(
                        `Could not parse workspace file '${file}': ${e}`
                    );
                }
            });
        logger.debug(`Found ${workspaces.length} workspace(s) in the VS Code workspace`);
        workspaces.sort((a, b) => a.name.localeCompare(b.name));
        ExtensionState.getInstance().workspace.set(...workspaces);
    });

    IarVsc.ewwWatcher.onFileModified(async modifiedFile => {
        const workspaceModel = ExtensionState.getInstance().workspace;
        const oldWorkspace = workspaceModel.workspaces.find(
            ws => OsUtils.pathsEqual(ws.path, modifiedFile)
        );
        if (oldWorkspace) {
            const reloadedWorkspace = new EwwFile(modifiedFile);
            if (!await EwWorkspace.equal(oldWorkspace, reloadedWorkspace)) {
                const updatedWorkspaces: EwWorkspace[] = [];
                workspaceModel.workspaces.forEach(workspace => {
                    if (workspace === oldWorkspace) {
                        updatedWorkspaces.push(reloadedWorkspace);
                    } else {
                        updatedWorkspaces.push(workspace);
                    }
                });
                workspaceModel.set(...updatedWorkspaces);
            } else {
                if (ExtensionState.getInstance().workspace.selected === oldWorkspace) {
                    await ExtensionState.getInstance().reloadWorkspace();
                }
            }
        }
    });

    // Projects
    IarVsc.ewpWatcher = await FileListWatcher.initialize("**/*.ewp");
    context.subscriptions.push(IarVsc.ewpWatcher);

    IarVsc.ewpWatcher.subscribe(files => {
        const projects: Project[] = [];
        files.
            filter(file => !Project.isIgnoredFile(file)).
            forEach(file => {
                try {
                    projects.push(new EwpFile(file));
                } catch (e) {
                    logger.error(`Could not parse project file '${file}': ${e}`);
                    vscode.window.showErrorMessage(
                        `Could not parse project file '${file}': ${e}`
                    );
                }
            });
        projects.sort((a, b) => a.name.localeCompare(b.name));
        if (JSON.stringify(projects) !== JSON.stringify(ExtensionState.getInstance().getFallbackProjects())) {
            logger.debug(`Found ${projects.length} project(s) in the VS Code workspace`);
            ExtensionState.getInstance().setFallbackProjects(projects);
        }
    });

    IarVsc.ewpWatcher.onFileModified(async modifiedFile => {
        const projectModel = ExtensionState.getInstance().project;
        const oldProject = projectModel.projects.find(
            project => OsUtils.pathsEqual(project.path, modifiedFile)
        );
        if (oldProject) {
            await ExtensionState.getInstance().reloadProject(oldProject);

            const reloadedProject = new EwpFile(modifiedFile);
            if (!Project.equal(oldProject, reloadedProject)) {
                const updatedProjects: Project[] = [];
                projectModel.projects.forEach(project => {
                    if (project === oldProject) {
                        updatedProjects.push(reloadedProject);
                    } else {
                        updatedProjects.push(project);
                    }
                });
                projectModel.set(...updatedProjects);
            }
        }
    });

    ExtensionSettings.observeSetting(ExtensionSettings.ExtensionSettingsField.ProjectsToExclude, () =>
        IarVsc.ewpWatcher?.refreshFiles());
}

async function loadTools(addWorkbenchCommand?: Command<unknown>) {
    IarVsc.workbenchesLoading.next(true);
    const roots = ExtensionSettings.getIarInstallDirectories();

    await IarVsc.toolManager.collectWorkbenches(roots, true);
    if (IarVsc.toolManager.workbenches.length === 0 && addWorkbenchCommand) {
        vscode.window.showErrorMessage(
            "Unable to find any IAR toolchains to use. You must locate one before you can use this extension.",
            "Add IAR toolchain").
            then(response => {
                if (response === "Add IAR toolchain") {
                    vscode.commands.executeCommand(addWorkbenchCommand.id);
                }
            });
    }
    IarVsc.workbenchesLoading.next(false);

}

export namespace IarVsc {
    export let extensionContext: vscode.ExtensionContext | undefined;
    export const toolManager = new IarToolManager();
    export const workbenchesLoading = new BehaviorSubject<boolean>(false);
    export let ewwWatcher: FileListWatcher | undefined;
    export let ewpWatcher: FileListWatcher | undefined;
    // exported mostly for testing purposes
    export let settingsView: SettingsWebview;
    export let projectTreeView: TreeProjectView;
    export let batchbuildTreeView: TreeBatchBuildView;
}
