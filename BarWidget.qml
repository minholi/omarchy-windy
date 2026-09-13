import QtQuick
import qs.Commons
import qs.Ui

// Bar entry point for the Windy widget. Panel.qml owns location detection and
// the forecast fetch; this root renders the pill (wind, temperature, or both)
// and forwards the lifecycle calls the shell routes through it.
BarWidget {
  id: root
  moduleName: "io.github.minholi.windy"

  readonly property var panelItem: panelLoader.item
  readonly property var current: panelItem ? panelItem.current : null
  readonly property string speedLabel: panelItem ? panelItem.speedLabel : ""
  readonly property bool hasData: !!current && speedLabel !== ""

  readonly property string displayMode: setting("display", "temp")
  readonly property string conditionGlyph: panelItem ? panelItem.conditionGlyph : ""
  readonly property string temperatureText: panelItem ? panelItem.temperatureText : ""

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function refresh() {
    if (panelItem) panelItem.refresh(true)
  }

  function toggle() {
    if (panelItem) panelItem.toggle()
  }

  readonly property bool opened: panelItem ? panelItem.opened === true : false

  function open() {
    if (panelItem && panelItem.openFromHotkey) panelItem.openFromHotkey()
  }

  function close() {
    if (panelItem && panelItem.close) panelItem.close()
  }

  readonly property bool popoutSwitchClosing: panelItem ? panelItem.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelItem) panelItem.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    labelVisible: false
    hasVisualContent: true
    dimmed: !root.hasData
    fixedWidth: root.vertical ? -1 : content.implicitWidth + button.scaledHorizontalMargin * 2
    tooltipText: root.panelItem ? root.panelItem.tooltipText : "Windy"

    onPressed: function(b) {
      if (!root.bar) return
      if (b === Qt.MiddleButton) root.refresh()
      else if (b === Qt.RightButton) { if (root.panelItem) root.panelItem.openWindy() }
      else root.toggle()
    }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.space(3)

      // Condition icon leads in temp/both so the temperature block keeps the
      // same position whether or not the wind group is shown.
      Text {
        id: conditionText
        anchors.verticalCenter: parent.verticalCenter
        visible: root.displayMode !== "wind"
        textFormat: Text.PlainText
        text: root.hasData && root.conditionGlyph !== "" ? root.conditionGlyph : "\uf72e"
        color: button.active && button.useActiveColor ? button.activeColor : button.foreground
        font.family: button.fontFamily
        font.pixelSize: Style.font.body
        renderType: Text.NativeRendering
      }

      Text {
        id: temperatureTextItem
        anchors.verticalCenter: parent.verticalCenter
        visible: root.hasData && !root.vertical && root.displayMode !== "wind"
        textFormat: Text.PlainText
        text: root.temperatureText
        color: button.foreground
        font.family: button.fontFamily
        font.pixelSize: Style.font.body
        renderType: Text.NativeRendering
      }

      Item {
        width: Style.space(5)
        height: 1
        visible: root.displayMode === "both" && !root.vertical
      }

      Text {
        id: arrowText
        anchors.verticalCenter: parent.verticalCenter
        // Vertical bars show a single glyph, so "both" keeps the condition.
        visible: root.displayMode !== "temp" && !(root.vertical && root.displayMode === "both")
        textFormat: Text.PlainText
        text: root.hasData ? "\uf062" : "\uf72e"  // nf-fa-arrow_up / nf-fa-wind
        rotation: root.hasData && root.current ? root.current.toward : 0
        color: button.active && button.useActiveColor ? button.activeColor : button.foreground
        font.family: button.fontFamily
        font.pixelSize: Style.font.body
        renderType: Text.NativeRendering
      }

      Text {
        id: speedText
        anchors.verticalCenter: parent.verticalCenter
        visible: root.hasData && !root.vertical && root.displayMode !== "temp"
        textFormat: Text.PlainText
        text: root.speedLabel
        color: button.foreground
        font.family: button.fontFamily
        font.pixelSize: Style.font.body
        renderType: Text.NativeRendering
      }
    }
  }
}
