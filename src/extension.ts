"use strict";

import { execFile } from "child_process";
import * as vscode from "vscode";
import { AppInsights } from "./appInsights";
import { AppInsightsClient } from "./appInsightsClient";
import { buildTree, ITestTreeNode, mergeSingleItemTrees } from "./buildTree";
import { DotnetTestExplorer } from "./dotnetTestExplorer";
import { Executor } from "./executor";
import { FindTestInContext } from "./findTestInContext";
import { GotoTest } from "./gotoTest";
import { LeftClickTest } from "./leftClickTest";
import { Logger } from "./logger";
import { parseTestName } from "./parseTestName";
import { Problems } from "./problems";
import { StatusBar } from "./statusBar";
import { TestCommands } from "./testCommands";
import { createTestController } from "./testController";
import { TestDirectories } from "./testDirectories";
import { TestNode } from "./testNode";
import { TestStatusCodeLensProvider } from "./testStatusCodeLensProvider";
import { Utility } from "./utility";
import { Watch } from "./watch";

export function activate(context: vscode.ExtensionContext) {
    const testDirectories = new TestDirectories();
    const testCommands = new TestCommands(testDirectories);
    const gotoTest = new GotoTest();
    const findTestInContext = new FindTestInContext();
    const problems = new Problems(testCommands);
    const statusBar = new StatusBar(testCommands);
    const watch = new Watch(testCommands, testDirectories);
    const leftClickTest = new LeftClickTest();
    const appInsights = new AppInsights(testCommands, testDirectories);

    const env = {
        ...process.env,
        DOTNET_CLI_UI_LANGUAGE: "en",
        VSTEST_HOST_DEBUG: "0",
    };

    const controller = createTestController(context);

    for (const folder of vscode.workspace.workspaceFolders) {
        const options = {
            cwd: folder.uri.fsPath,
            env
        }
        execFile("dotnet", ["test", "--list-tests", "--verbosity=quiet"], options, (error, stdout, stderr) => {
            console.log(stdout);
            if (error) {
                console.error(error);
                // some error happened
                // TODO: log it (properly)
                return;
            }

            const lines = stdout.split(/\n\r?|\r/);
            const rawTests = lines.filter(line => /^    /.test(line));
            const parsedTestNames = rawTests.map(x => parseTestName(x.trim()));
            // const rootTree = mergeSingleItemTrees(buildTree(parsedTestNames));
            const rootTree = buildTree(parsedTestNames);

            // convert the tree into tests
            const generateNode = (tree: ITestTreeNode) => {
                const treeNode = controller.createTestItem(tree.fullName, tree.name);
                for (const subTree of tree.subTrees.values()) {
                    treeNode.children.add(generateNode(subTree));
                }
                for (const test of tree.tests) {
                        const _fqn = Utility.getFqnTestName(
                            tree.fullName + "." + test
                        ).replace("+", ".");
                        treeNode.children.add(
                            controller.createTestItem(
                                tree.fullName + "." + test,
                                test,
                                // vscode.Uri.parse(`command:dotnet-test-explorer.newGotoTest`) // doesn't work but need a uri to get icon to show, test extension expects a file / folder uri
                                vscode.Uri.parse(`vscdnte:${_fqn}`)
                            )
                        );
                }

                return treeNode;
            }

            const rootNode = generateNode(rootTree);
            rootNode.label = folder.name;
            controller.items.add(rootNode);
        });
    }

    Logger.Log("Starting extension");

    testDirectories.parseTestDirectories();

    context.subscriptions.push(controller);
    context.subscriptions.push(problems);
    context.subscriptions.push(statusBar);
    context.subscriptions.push(testCommands);

    Utility.updateCache();

    const dotnetTestExplorer = new DotnetTestExplorer(context, testCommands, statusBar);
    vscode.window.registerTreeDataProvider("dotnetTestExplorer", dotnetTestExplorer);
    AppInsightsClient.sendEvent("loadExtension");

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
        if (!e.affectsConfiguration("dotnet-test-explorer")) { return; }

        if (e.affectsConfiguration("dotnet-test-explorer.testProjectPath")) {
            testDirectories.parseTestDirectories();
            testCommands.discoverTests();
        }

        dotnetTestExplorer._onDidChangeTreeData.fire(null);

        Utility.updateCache();
    }));

    testCommands.discoverTests();

    const codeLensProvider = new TestStatusCodeLensProvider(testCommands);
    context.subscriptions.push(codeLensProvider);
    context.subscriptions.push(vscode.languages.registerCodeLensProvider(
        { language: "csharp", scheme: "file" },
        codeLensProvider));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider(
        { language: "fsharp", scheme: "file" },
        codeLensProvider
    ));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.showLog", () => {
        Logger.Show();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.openPanel", () => {
        vscode.commands.executeCommand("workbench.view.extension.test");
    }));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.stop", () => {
        Executor.stop();
        dotnetTestExplorer._onDidChangeTreeData.fire(null);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.refreshTestExplorer", () => {
        testDirectories.parseTestDirectories();
        dotnetTestExplorer.refreshTestExplorer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.runAllTests", () => {
        testCommands.runAllTests();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.runTest", (test: TestNode) => {
        testCommands.runTest(test);
    }));

    context.subscriptions.push(vscode.commands.registerTextEditorCommand("dotnet-test-explorer.runTestInContext", (editor: vscode.TextEditor) => {
        findTestInContext.find(editor.document, editor.selection.start).then((testRunContext) => {
            testCommands.runTestByName(testRunContext.testName, testRunContext.isSingleTest);
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.gotoTest", (test: TestNode) => {
        gotoTest.go(test);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.debugTest", (test: TestNode) => {
        testCommands.debugTestByName(test.fqn, true);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.rerunLastCommand", (test: TestNode) => {
        testCommands.rerunLastCommand();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("dotnet-test-explorer.leftClickTest", (test: TestNode) => {
        leftClickTest.handle(test);
    }));

    context.subscriptions.push(vscode.window.onDidCloseTerminal((closedTerminal: vscode.Terminal) => {
        Executor.onDidCloseTerminal(closedTerminal);
    }));
}

export function deactivate() {
}
