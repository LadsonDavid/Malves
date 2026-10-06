/**
 * The one place icons come from (Heroicons outline, MIT; see THIRD-PARTY.md),
 * so the whole app stays one icon family. Add an alias here rather than
 * importing react-native-heroicons in a screen.
 */
export { default as Back } from "react-native-heroicons/outline/ArrowLeftIcon";
export { default as Refresh } from "react-native-heroicons/outline/ArrowPathIcon";
export { default as External } from "react-native-heroicons/outline/ArrowTopRightOnSquareIcon";
export { default as Undo } from "react-native-heroicons/outline/ArrowUturnLeftIcon";
export { default as Bell } from "react-native-heroicons/outline/BellIcon";
export { default as Bolt } from "react-native-heroicons/outline/BoltIcon";
export { default as Memory } from "react-native-heroicons/outline/BookOpenIcon";
export { default as Conversation } from "react-native-heroicons/outline/ChatBubbleLeftRightIcon";
export { default as Check } from "react-native-heroicons/outline/CheckIcon";
export { default as ChevronRight } from "react-native-heroicons/outline/ChevronRightIcon";
export { default as Clock } from "react-native-heroicons/outline/ClockIcon";
export { default as Settings } from "react-native-heroicons/outline/Cog6ToothIcon";
export { default as Terminal } from "react-native-heroicons/outline/CommandLineIcon";
export { default as Desktop } from "react-native-heroicons/outline/ComputerDesktopIcon";
export { default as Document } from "react-native-heroicons/outline/DocumentTextIcon";
export { default as Mail } from "react-native-heroicons/outline/EnvelopeIcon";
export { default as Warning } from "react-native-heroicons/outline/ExclamationTriangleIcon";
export { default as Globe } from "react-native-heroicons/outline/GlobeAltIcon";
export { default as Home } from "react-native-heroicons/outline/HomeIcon";
export { default as Info } from "react-native-heroicons/outline/InformationCircleIcon";
export { default as Mic } from "react-native-heroicons/outline/MicrophoneIcon";
export { default as Send } from "react-native-heroicons/outline/PaperAirplaneIcon";
export { default as Play } from "react-native-heroicons/outline/PlayIcon";
export { default as Plus } from "react-native-heroicons/outline/PlusIcon";
export { default as Tasks } from "react-native-heroicons/outline/QueueListIcon";
export { default as Online } from "react-native-heroicons/outline/SignalIcon";
export { default as Offline } from "react-native-heroicons/outline/SignalSlashIcon";
export { default as Speaker } from "react-native-heroicons/outline/SpeakerWaveIcon";
export { default as Stop } from "react-native-heroicons/outline/StopIcon";
export { default as Trash } from "react-native-heroicons/outline/TrashIcon";
export { default as Leads } from "react-native-heroicons/outline/UserGroupIcon";
export { default as Close } from "react-native-heroicons/outline/XMarkIcon";

/** Every icon takes these. */
export type IconProps = { size?: number; color?: string };
export type Icon = (props: IconProps) => React.JSX.Element;
