import * as vscode from 'vscode';

export class StatusBar 
    implements vscode.Disposable
{
    private buildStatusItem =
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5.04);

        private configStatusItem =
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5.035);

    private buildConfigStatusItem =
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5.03);

    private debugStatusItem =
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5.021);

    private runStatusItem =
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5.02);


    private debugConfigStatusItem =
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5.01);

    private killStatusItem =
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5.00);

    constructor()
    {
        this.buildStatusItem.command = "xcodebuild-tools.build";
        this.buildStatusItem.tooltip = "Click to build the project";
        this.buildStatusItem.text = "$(gear) xcodebuild:";

        this.buildConfigStatusItem.command = "xcodebuild-tools.selectBuildConfiguration";
        this.buildConfigStatusItem.tooltip = "Click to select the build configuration";
    
        this.debugStatusItem.command = "xcodebuild-tools.debug";
        this.debugStatusItem.tooltip = "Click to launch the debugger for the selected debug configuration";
        this.debugStatusItem.text = "$(bug)";

        this.runStatusItem.command = "xcodebuild-tools.run";
        this.runStatusItem.tooltip = "Click to run (without debugging) the selected debug configuration";
        this.runStatusItem.text = "$(triangle-right)";

        this.configStatusItem.command = "xcodebuild-tools.selectConfiguration";
        this.configStatusItem.tooltip = "Click to select the workspace and scheme";

        this.debugConfigStatusItem.command = "xcodebuild-tools.selectDebugConfiguration";
        this.debugConfigStatusItem.tooltip = "Click to select the debug configuration";

        this.killStatusItem.command = "xcodebuild-tools.kill";
        this.killStatusItem.tooltip = "Click to kill current build";
        this.killStatusItem.text = "$(x)";
    }

    public forallItems(f: (item:vscode.StatusBarItem)=>void)
    {
        f(this.buildStatusItem);
        f(this.buildConfigStatusItem);
        f(this.debugStatusItem);
        f(this.runStatusItem);
        f(this.configStatusItem);
        f(this.debugConfigStatusItem);
        f(this.killStatusItem);
    }

    public dispose()
    {
        this.forallItems(i => i.dispose());
    }

    public show()
    {
        this.forallItems(i => i.show());
    }

    public hide()
    {
        this.forallItems(i => i.hide());
    }

    public update(config: string, buildConfig: string, debugConfig:string)
    {
        this.configStatusItem.text = config;
        this.buildConfigStatusItem.text = buildConfig;
        this.debugConfigStatusItem.text = debugConfig;

        this.show();
    }
}
