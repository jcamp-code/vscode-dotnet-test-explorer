import * as vscode from 'vscode'
import { Utility } from './utility'
import { parseTestName } from './parseTestName'
import { buildTree, ITestTreeNode, mergeSingleItemTrees } from './buildTree'
import { TestCommands } from './testCommands'
import { StatusBar } from './statusBar'
import { TestNode } from './testNode'
import { ITestResult } from './testResult'
import { Logger } from './logger'
import { GotoTest } from './gotoTest'

export interface TestControllerExtended extends vscode.TestController {
  discoveredTests: string[]
}

export function createTestController(
  context: vscode.ExtensionContext,
  testCommands: TestCommands,
  statusBar: StatusBar
): vscode.TestController {
  const controller = vscode.tests.createTestController(
    'dotnet-test-explorer',
    'Dot Net Tests'
  ) as TestControllerExtended

  // extend the VSC controller with additional properties
  controller.discoveredTests = []

  // https://github.com/microsoft/vscode/blob/b7d5b65a13299083e92bca91be8fa1289e95d5c1/src/vs/workbench/contrib/testing/browser/testing.contribution.ts
  // https://github.com/microsoft/vscode/blob/c11dabf9ce669f599a18d7485d397834abc1c8e1/src/vs/workbench/api/common/extHostTesting.ts - controller
  const commandHandler = async (extId: string) => {
    try {
      const parts = extId.split('\0')

      let current = controller.items.get(parts[1])

      for (let x = 2; x < parts.length; x++) {
        current = current.children.get(parts[x])
      }

      // should be left with desired testitem as current
      if (current && current.id) {
        vscode.commands.executeCommand('dotnet-test-explorer.gotoTest', {
          fqn: Utility.getFqnTestName(current.id).replace('+', '.'),
        })
      }
    } catch {}
  }
  context.subscriptions.push(vscode.commands.registerCommand('vscode.revealTest', commandHandler))

  async function buildItems() {
    const treeMode = Utility.getConfiguration().get<string>('treeMode')

    function createConcreteTree(parentNamespace: string, abstractTree: ITestTreeNode): TestNode {
      const children = []
      for (const subNamespace of abstractTree.subTrees.values()) {
        children.push(createConcreteTree(abstractTree.fullName, subNamespace))
      }
      for (const test of abstractTree.tests) {
        const testNode = new TestNode(abstractTree.fullName, test, [])
        children.push(testNode)
      }
      return new TestNode(parentNamespace, abstractTree.name, [], children)
    }

    const parsedTestNames = controller.discoveredTests.map(parseTestName)
    let tree = buildTree(parsedTestNames)

    if (treeMode === 'merged') {
      tree = mergeSingleItemTrees(tree)
    }

    const concreteRoot = createConcreteTree('', tree)

    // have original tree for original explorer
    const generateItemFromNode = async (tree: TestNode) => {
      const _fqn = Utility.getFqnTestName(tree.fullName).replace('+', '.')

      const gotoTest = new GotoTest()
      const symbol = await gotoTest.info(tree)
      const treeNode = controller.createTestItem(tree.fullName, tree.name, symbol?.uri)
      treeNode.range = symbol?.range
      if (tree.children) {
        for (const subTree of tree.children) {
          treeNode.children.add(await generateItemFromNode(subTree))
        }
      }

      return treeNode
    }
    const vsTestRoot = await generateItemFromNode(concreteRoot)

    vsTestRoot.children.forEach((sub) => {
      controller.items.add(sub)
    })
  }

  async function addTestResults(run: vscode.TestRun, results: ITestResult) {
    const fullNamesForTestResults = results.testResults.map((r) => r.fullName)

    if (results.clearPreviousTestResults) {
      controller.discoveredTests = [...fullNamesForTestResults]
      await buildItems()
    } else {
      const newTests = fullNamesForTestResults.filter(
        (r) => controller.discoveredTests.indexOf(r) === -1
      )

      if (newTests.length > 0) {
        controller.discoveredTests.push(...newTests)
        await buildItems()
      }
    }

    controller.discoveredTests = controller.discoveredTests.sort()

    statusBar.discovered(controller.discoveredTests.length)

    function searchTestItems(item: vscode.TestItemCollection, name: string) {
      let result = null
      item.forEach((child) => {
        if (child.id === name) result = child
      })
      if (!result) {
        item.forEach((child) => {
          if (!result) result = searchTestItems(child.children, name)
        })
      }
      return result
    }

    if (results.testResults) {
      results.testResults.forEach((result) => {
        const item = searchTestItems(controller.items, result.fullName)

        if (item) {
          Logger.Log(`${item.id}: ${result.outcome}`)
          if (result.outcome === 'Failed')
            run.failed(item, { message: result.message }, result.duration)
          else if (result.outcome === 'NotExecuted') run.skipped(item)
          else if (result.outcome === 'Passed') run.passed(item, result.duration)
          else console.log('unexpected value for outcome: ' + result.outcome)
          if (result.output) run.appendOutput(result.output, item)

          return
        }
      })
    }

    statusBar.testRun(results.testResults)
  }

  controller.refreshHandler = async (token) => {
    statusBar.discovering()
    controller.items.replace([])
    const results = await testCommands.discoverTests()

    controller.discoveredTests = [].concat(...results.map((r) => r.testNames))
    await buildItems()
    statusBar.discovered(controller.discoveredTests.length)
  }

  async function runProfile(run: vscode.TestRun, request: vscode.TestRunRequest, debug: boolean) {
    const createFilterArg = (item: vscode.TestItem, negate: boolean) => {
      const fullMatch = item.children.size === 0
      const operator = (negate ? '!' : '') + (fullMatch ? '=' : '~')
      const fullyQualifiedName = item.id.replaceAll(/\(.*\)/g, '')
      return `FullyQualifiedName${operator}${fullyQualifiedName}`
    }

    const excludeFilters = request.exclude.map((item) => createFilterArg(item, true))

    function startChildren(item: vscode.TestItem) {
      run.started(item)
      item.children.forEach((child) => {
        startChildren(child)
      })
    }
    if (request.include) {
      //async mapping https://stackoverflow.com/questions/40140149/use-async-await-with-array-map
      const itemPromises = request.include.map(async (item) => {
        startChildren(item)
        const result = await testCommands.runTestCommand(
          item.id,
          item.children.size == 0,
          false,
          excludeFilters
        )
        if (result) await addTestResults(run, result)
      })

      await Promise.all(itemPromises)
    } else {
      controller.items.forEach((child) => {
        startChildren(child)
      })
      const result = await testCommands.runTestCommand('', false, debug, excludeFilters)
      if (result) await addTestResults(run, result)
    }

    run.end()
  }

  controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, async (request, token) => {
    const run = controller.createTestRun(request, 'My test run', true)
    await runProfile(run, request, false)
  })

  controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, async (request, token) => {
    const run = controller.createTestRun(request, 'My test run', true)
    await runProfile(run, request, true)
  })

  /*
  Haven't come up with a great way to integrate this.
  controller.createRunProfile('Watch', vscode.TestRunProfileKind.Run, async (request, token) => {
    const run = controller.createTestRun(request, 'My test run', true)
    const wait = () => new Promise((resolve) => setTimeout(resolve, 100))

    let tests = request.include ?? controller.items
    while (!token.isCancellationRequested) {
      tests.forEach((test) => {
        run.enqueued(test)
      })
      await wait()
      tests.forEach((test) => {
        run.started(test)
      })
      await wait()
      tests.forEach((test) => {
        run.passed(test)
      })
      await wait()
    }
    run.end()
  })
  */

  return controller
}
