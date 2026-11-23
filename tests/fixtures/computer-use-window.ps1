param([Parameter(Mandatory = $true)][string]$WindowTitle, [string]$PauseRequest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System.Windows.Forms;
public sealed class ComputerUseTestWindow : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
}
'@ -ReferencedAssemblies System.Windows.Forms -WarningAction SilentlyContinue
$form = New-Object ComputerUseTestWindow
$form.Text = $WindowTitle
$form.Width = 540
$form.Height = 205
$form.ShowInTaskbar = $false
$field = New-Object System.Windows.Forms.TextBox
$field.AccessibleName = 'Test input'
$field.SetBounds(16, 15, 480, 44)
$field.Multiline = $true
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Verify'
$button.SetBounds(16, 72, 110, 31)
$button.Add_Click({ $button.Text = if ($button.Text -eq 'Verify') { 'Verified' } else { 'Clicked twice' } })
$minimize = New-Object System.Windows.Forms.Button
$minimize.Text = 'Minimize fixture'
$minimize.SetBounds(159, 72, 170, 31)
$minimize.Add_Click({ $form.WindowState = 'Minimized' })
$form.Controls.AddRange(@($field, $button, $minimize))
$form.Add_Shown({
    $center = $button.PointToScreen([Drawing.Point]::new(50, 15))
    [Console]::Out.WriteLine((@{ pid = $PID; window_id = $form.Handle.ToInt64()
        x = ($center.X - $form.Left) / $form.Width; y = ($center.Y - $form.Top) / $form.Height
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 180000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
$pauseTimer = New-Object System.Windows.Forms.Timer
$pauseTimer.Interval = 100
$pauseTimer.Add_Tick({
    if ($PauseRequest -and [IO.File]::Exists($PauseRequest)) {
        [IO.File]::Move($PauseRequest, $PauseRequest + '.started')
        [Threading.Thread]::Sleep(4500)
    }
})
if ($PauseRequest) { $pauseTimer.Start() }
try { [System.Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $pauseTimer.Dispose(); $form.Dispose() }
