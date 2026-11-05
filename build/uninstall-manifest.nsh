; Remove only files recorded by afterPack. Never recursively remove an install root.
Function un.MineradioTrimManifestLine
  Exch $0
  Push $1
  trim_manifest_line:
    StrCpy $1 "$0" 1 -1
    StrCmp $1 "$\r" trim_manifest_char
    StrCmp $1 "$\n" trim_manifest_char trim_manifest_done
  trim_manifest_char:
    StrCpy $0 "$0" -1
    Goto trim_manifest_line
  trim_manifest_done:
  Pop $1
  Exch $0
FunctionEnd

Function un.MineradioManifestPathIsSafe
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $1 "0"
  StrCpy $2 "$0" 1
  StrCmp $2 "" manifest_path_done
  StrCmp $2 "\" manifest_path_done
  StrCmp $2 "/" manifest_path_done
  StrCpy $3 "0"
  StrCpy $6 ""
  manifest_path_chars:
    StrCpy $2 "$0" 1 $3
    StrCmp $2 "" manifest_path_chars_done
    StrCmp $2 ":" manifest_path_done
    StrCmp $2 "*" manifest_path_done
    StrCmp $2 "?" manifest_path_done
    StrCmp $2 "/" manifest_path_done
    StrCmp $2 "|" manifest_path_done
    ${If} $2 == "\"
      ${If} $6 == "."
      ${OrIf} $6 == " "
      ${OrIf} $6 == "\"
        Goto manifest_path_done
      ${EndIf}
    ${EndIf}
    StrCpy $6 "$2"
    IntOp $3 $3 + 1
    Goto manifest_path_chars
  manifest_path_chars_done:
    StrCmp $6 "." manifest_path_done
    StrCmp $6 " " manifest_path_done
    StrCmp $6 "\" manifest_path_done
    GetFullPathName $2 "$INSTDIR\$0"
    StrLen $3 "$INSTDIR\"
    StrCpy $4 "$2" $3
    StrCmp $4 "$INSTDIR\" 0 manifest_path_done
    StrCpy $4 "$2"
  manifest_path_parents:
    ; Junctions/reparse points may resolve outside the lexical install root.
    System::Call 'kernel32::GetFileAttributesW(w r4) i .r5'
    ${If} $5 != -1
      IntOp $5 $5 & 0x400
      ${If} $5 != 0
        Goto manifest_path_done
      ${EndIf}
    ${EndIf}
    StrCmp $4 "$INSTDIR" manifest_path_safe
    ${GetParent} "$4" $4
    StrCmp $4 "" manifest_path_done
    Goto manifest_path_parents
  manifest_path_safe:
    StrCpy $1 "1"
  manifest_path_done:
    StrCpy $0 "$1"
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Exch $0
FunctionEnd

Function un.MineradioRemoveManifestFiles
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  ClearErrors
  FileOpen $0 "$INSTDIR\.mineradio-installed-files" r
  ${If} ${Errors}
    Goto manifest_remove_done
  ${EndIf}
  FileReadUTF16LE $0 $1
  Push "$1"
  Call un.MineradioTrimManifestLine
  Pop $1
  StrCmp $1 "appId=${MINERADIO_MARKER_APP_ID}" 0 manifest_remove_close
  manifest_remove_loop:
    ClearErrors
    FileReadUTF16LE $0 $1
    ${If} ${Errors}
      Goto manifest_remove_finished
    ${EndIf}
    Push "$1"
    Call un.MineradioTrimManifestLine
    Pop $1
    StrCpy $2 "$1" 2
    StrCpy $3 "$1" "" 2
    ${If} $2 != "F|"
    ${AndIf} $2 != "D|"
      Goto manifest_remove_loop
    ${EndIf}
    Push "$3"
    Call un.MineradioManifestPathIsSafe
    Pop $4
    ${If} $4 == "1"
      ${If} $2 == "F|"
        Delete "$INSTDIR\$3"
      ${Else}
        RMDir "$INSTDIR\$3"
      ${EndIf}
    ${EndIf}
    Goto manifest_remove_loop
  manifest_remove_finished:
    FileClose $0
    Delete "$INSTDIR\.mineradio-installed-files"
    Delete "$INSTDIR\${MINERADIO_INSTALL_MARKER}"
    Goto manifest_remove_done
  manifest_remove_close:
    FileClose $0
  manifest_remove_done:
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
FunctionEnd
