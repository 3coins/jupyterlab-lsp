import { CodeJumper } from '@krassowski/code-jumpers/lib/jumpers/jumper';
import { FileEditorJumper } from '@krassowski/code-jumpers/lib/jumpers/fileeditor';
import { NotebookJumper } from '@krassowski/code-jumpers/lib/jumpers/notebook';
import { PositionConverter } from '../converter';
import { IVirtualPosition } from '../positioning';
import { getModifierState, uri_to_contents_path, uris_equal } from '../utils';
import { AnyLocation } from 'lsp-ws-connection/lib/types';
import {
  FeatureSettings,
  IFeatureCommand,
  IFeatureLabIntegration
} from '../feature';
import { CodeMirrorIntegration } from '../editor_integration/codemirror';
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { ILSPAdapterManager, ILSPFeatureManager, PLUGIN_ID } from '../tokens';
import { LabIcon } from '@jupyterlab/ui-components';
import jumpToSvg from '../../style/icons/jump-to.svg';
import { URLExt } from '@jupyterlab/coreutils';
import { CodeJump as LSPJumpSettings, ModifierKey } from '../_jump_to';
import { ISettingRegistry } from '@jupyterlab/settingregistry';

export const jumpToIcon = new LabIcon({
  name: 'lsp:jump-to',
  svgstr: jumpToSvg
});

const FEATURE_ID = PLUGIN_ID + ':jump_to';

export class CMJumpToDefinition extends CodeMirrorIntegration {
  get jumper() {
    return (this.feature.labIntegration as JumperLabIntegration).jumper;
  }

  get settings() {
    return super.settings as FeatureSettings<LSPJumpSettings>;
  }

  protected get modifierKey(): ModifierKey {
    return this.settings.composite.modifierKey;
  }

  register() {
    this.editor_handlers.set(
      'mousedown',
      (virtual_editor, event: MouseEvent) => {
        let root_position = this.position_from_mouse(event);
        let document = virtual_editor.document_at_root_position(root_position);
        let virtual_position = virtual_editor.root_position_to_virtual_position(
          root_position
        );

        const { button } = event;
        if (button === 0 && getModifierState(event, this.modifierKey)) {
          this.connection
            .getDefinition(virtual_position, document.document_info, false)
            .then(targets => {
              this.handle_jump(targets, document.document_info.uri).catch(
                console.warn
              );
            })
            .catch(console.warn);
          event.preventDefault();
          event.stopPropagation();
        }
      }
    );
    super.register();
  }

  get_uri_and_range(location_or_locations: AnyLocation) {
    if (location_or_locations == null) {
      return;
    }
    // some language servers appear to return a single object
    const locations = Array.isArray(location_or_locations)
      ? location_or_locations
      : [location_or_locations];

    // TODO: implement selector for multiple locations
    //  (like when there are multiple definitions or usages)
    //  could use the showHints() or completion frontend as a reference
    if (locations.length === 0) {
      return;
    }

    console.log('Will jump to the first of suggested locations:', locations);

    const location_or_link = locations[0];

    if ('targetUri' in location_or_link) {
      return {
        uri: location_or_link.targetUri,
        range: location_or_link.targetRange
      };
    } else if ('uri' in location_or_link) {
      return {
        uri: location_or_link.uri,
        range: location_or_link.range
      };
    }
  }

  async handle_jump(location_or_locations: AnyLocation, document_uri: string) {
    const target_info = this.get_uri_and_range(location_or_locations);

    if (!target_info) {
      this.status_message.set('No jump targets found', 2 * 1000);
      return;
    }

    let { uri, range } = target_info;

    let virtual_position = PositionConverter.lsp_to_cm(
      range.start
    ) as IVirtualPosition;

    if (uris_equal(uri, document_uri)) {
      let editor_index = this.adapter.get_editor_index_at(virtual_position);
      // if in current file, transform from the position within virtual document to the editor position:
      let editor_position = this.virtual_editor.transform_virtual_to_editor(
        virtual_position
      );
      let editor_position_ce = PositionConverter.cm_to_ce(editor_position);
      console.log(`Jumping to ${editor_index}th editor of ${uri}`);
      console.log('Jump target within editor:', editor_position_ce);

      let contents_path = this.adapter.widget.context.path;

      this.jumper.global_jump({
        line: editor_position_ce.line,
        column: editor_position.ch,
        editor_index: editor_index,
        is_symlink: false,
        contents_path: contents_path
      });
    } else {
      // otherwise there is no virtual document and we expect the returned position to be source position:
      let source_position_ce = PositionConverter.cm_to_ce(virtual_position);
      console.log(`Jumping to external file: ${uri}`);
      console.log('Jump target (source location):', source_position_ce);

      let jump_data = {
        editor_index: 0,
        line: source_position_ce.line,
        column: source_position_ce.column
      };

      // assume that we got a relative path to a file within the project
      // TODO use is_relative() or something? It would need to be not only compatible
      //  with different OSes but also with JupyterHub and other platforms.

      // can it be resolved vs our guessed server root?
      let contents_path = uri_to_contents_path(uri);

      if (contents_path == null && uri.startsWith('file://')) {
        contents_path = decodeURI(uri.slice(7));
      }

      try {
        await this.jumper.document_manager.services.contents.get(
          contents_path,
          {
            content: false
          }
        );
        this.jumper.global_jump({
          contents_path,
          ...jump_data,
          is_symlink: false
        });
        return;
      } catch (err) {
        console.warn(err);
      }

      this.jumper.global_jump({
        contents_path: URLExt.join('.lsp_symlink', contents_path),
        ...jump_data,
        is_symlink: true
      });
    }
  }
}

class JumperLabIntegration implements IFeatureLabIntegration {
  private adapterManager: ILSPAdapterManager;
  private jumpers: Map<string, CodeJumper>;
  settings: FeatureSettings<any>;

  constructor(
    settings: FeatureSettings<any>,
    adapterManager: ILSPAdapterManager,
    fileEditorTracker: IEditorTracker,
    notebookTracker: INotebookTracker,
    documentManager: IDocumentManager
  ) {
    this.settings = settings;
    this.adapterManager = adapterManager;
    this.jumpers = new Map();

    fileEditorTracker.widgetAdded.connect((sender, widget) => {
      let fileEditor = widget.content;

      if (fileEditor.editor instanceof CodeMirrorEditor) {
        let jumper = new FileEditorJumper(widget, documentManager);
        this.jumpers.set(widget.id, jumper);
      }
    });

    notebookTracker.widgetAdded.connect(async (sender, widget) => {
      // NOTE: assuming that the default cells content factory produces CodeMirror editors(!)
      let jumper = new NotebookJumper(widget, documentManager);
      this.jumpers.set(widget.id, jumper);
    });
  }

  get jumper(): CodeJumper {
    let current = this.adapterManager.currentAdapter.widget.id;
    return this.jumpers.get(current);
  }
}

const COMMANDS: IFeatureCommand[] = [
  {
    id: 'jump-to-definition',
    execute: async ({ connection, virtual_position, document, features }) => {
      const jump_feature = features.get(FEATURE_ID) as CMJumpToDefinition;
      const targets = await connection.getDefinition(
        virtual_position,
        document.document_info,
        false
      );
      await jump_feature.handle_jump(targets, document.document_info.uri);
    },
    is_enabled: ({ connection }) => connection.isDefinitionSupported(),
    label: 'Jump to definition',
    icon: jumpToIcon
  },
  {
    id: 'jump-back',
    execute: async ({ connection, virtual_position, document, features }) => {
      const jump_feature = features.get(FEATURE_ID) as CMJumpToDefinition;
      jump_feature.jumper.global_jump_back();
    },
    is_enabled: ({ connection }) => connection.isDefinitionSupported(),
    label: 'Jump back',
    icon: jumpToIcon
  }
];

export const JUMP_PLUGIN: JupyterFrontEndPlugin<void> = {
  id: FEATURE_ID,
  requires: [
    ILSPFeatureManager,
    ISettingRegistry,
    ILSPAdapterManager,
    IEditorTracker,
    INotebookTracker,
    IDocumentManager
  ],
  autoStart: true,
  activate: (
    app: JupyterFrontEnd,
    featureManager: ILSPFeatureManager,
    settingRegistry: ISettingRegistry,
    adapterManager: ILSPAdapterManager,
    fileEditorTracker: IEditorTracker,
    notebookTracker: INotebookTracker,
    documentManager: IDocumentManager
  ) => {
    const settings = new FeatureSettings(settingRegistry, FEATURE_ID);
    let labIntegration = new JumperLabIntegration(
      settings,
      adapterManager,
      fileEditorTracker,
      notebookTracker,
      documentManager
    );

    featureManager.register({
      feature: {
        editorIntegrationFactory: new Map([
          ['CodeMirrorEditor', CMJumpToDefinition]
        ]),
        commands: COMMANDS,
        id: FEATURE_ID,
        name: 'Jump to definition',
        labIntegration: labIntegration,
        settings: settings
      }
    });
  }
};
